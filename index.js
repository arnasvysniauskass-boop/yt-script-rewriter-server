const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

async function fetchJson(url, opts) {
  const { default: fetch } = await import('node-fetch');
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || data.error || `HTTP ${r.status}`);
  return data;
}

app.get('/health', (req, res) => res.json({ ok: true }));

// Fetch transcript via Supadata
app.post('/extract-audio', async (req, res) => {
  const { youtubeUrl, supadata_key } = req.body;
  if (!youtubeUrl || !supadata_key)
    return res.status(400).json({ error: 'youtubeUrl and supadata_key are required' });

  try {
    const { default: fetch } = await import('node-fetch');
    const r = await fetch(
      `https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(youtubeUrl)}&text=false`,
      { headers: { 'x-api-key': supadata_key } }
    );
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      return res.status(500).json({ error: 'Supadata error: ' + (e.error || r.status) });
    }
    const data = await r.json();
    const utterances = (data.content || []).map(seg => ({
      speaker: 'A',
      text: seg.text,
      start: seg.offset,
    }));
    res.json({ utterances });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Gemini TTS proxy — uses Sadachbia voice by default
app.post('/tts', async (req, res) => {
  const { text, ttsKey, voiceName } = req.body;
  if (!text || !ttsKey)
    return res.status(400).json({ error: 'text and ttsKey are required' });

  const MAX_CHARS = 4500;
  const sentences = text.match(/[^.!?\n]+[.!?\n]*/g) || [text];
  const chunks = [];
  let current = '';
  for (const s of sentences) {
    if ((current + s).length > MAX_CHARS && current) {
      chunks.push(current.trim());
      current = s;
    } else {
      current += s;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  try {
    const audioChunks = [];
    for (const chunk of chunks) {
      const d = await fetchJson(
        `https://texttospeech.googleapis.com/v1beta1/text:synthesize?key=${ttsKey}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            input: { text: chunk },
            voice: {
              languageCode: 'en-US',
              name: `en-US-${voiceName || 'Sadachbia'}`,
            },
            audioConfig: { audioEncoding: 'MP3' },
            model: 'gemini-2.5-flash-tts',
          }),
        }
      );
      audioChunks.push(d.audioContent);
    }
    res.json({ audioChunks });
  } catch (e) {
    res.status(500).json({ error: 'TTS failed: ' + e.message });
  }
});

const PORT = process.env.PORT || 3579;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

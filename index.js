const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

async function doFetch(url, opts) {
  const { default: fetch } = await import('node-fetch');
  return fetch(url, opts);
}

app.get('/health', (req, res) => res.json({ ok: true }));

// Fetch transcript via Supadata
app.post('/extract-audio', async (req, res) => {
  const { youtubeUrl, supadata_key } = req.body;
  if (!youtubeUrl || !supadata_key)
    return res.status(400).json({ error: 'youtubeUrl and supadata_key are required' });

  try {
    const r = await doFetch(
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

// Gemini TTS via Gemini API — supports Sadachbia and other Gemini voices
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
    const voice = voiceName || 'Sadachbia';

    for (const chunk of chunks) {
      const r = await doFetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${ttsKey}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: chunk }] }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: voice }
                }
              }
            }
          }),
        }
      );

      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error?.message || `Gemini TTS error ${r.status}`);
      }

      const data = await r.json();
      // Extract base64 audio from response
      const audioData = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!audioData) throw new Error('No audio data returned from Gemini TTS');
      audioChunks.push(audioData);
    }

    res.json({ audioChunks });
  } catch (e) {
    res.status(500).json({ error: 'TTS failed: ' + e.message });
  }
});

const PORT = process.env.PORT || 3579;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

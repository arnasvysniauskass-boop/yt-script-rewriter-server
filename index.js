const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

function cleanTmp(filePath) {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}
}

async function fetchJson(url, opts) {
  const { default: fetch } = await import('node-fetch');
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || data.error || `HTTP ${r.status}`);
  return data;
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/extract-audio', async (req, res) => {
  const { youtubeUrl, assemblyaiKey } = req.body;
  if (!youtubeUrl || !assemblyaiKey)
    return res.status(400).json({ error: 'youtubeUrl and assemblyaiKey are required' });

  const outPath = path.join(TMP_DIR, `audio_${Date.now()}.mp3`);
  const cmd = `yt-dlp -x --audio-format mp3 --audio-quality 5 -o "${outPath}" "${youtubeUrl}"`;

  exec(cmd, { timeout: 300000 }, async (err, stdout, stderr) => {
    if (err) {
      cleanTmp(outPath);
      return res.status(500).json({ error: 'yt-dlp failed: ' + (stderr || err.message) });
    }
    if (!fs.existsSync(outPath))
      return res.status(500).json({ error: 'Audio file not found after download.' });

    try {
      const { default: fetch } = await import('node-fetch');
      const stat = fs.statSync(outPath);
      const stream = fs.createReadStream(outPath);

      const uploadRes = await fetch('https://api.assemblyai.com/v2/upload', {
        method: 'POST',
        headers: {
          'authorization': assemblyaiKey,
          'content-type': 'audio/mpeg',
          'content-length': String(stat.size),
        },
        body: stream,
      });

      cleanTmp(outPath);

      if (!uploadRes.ok) {
        const e = await uploadRes.json().catch(() => ({}));
        return res.status(500).json({ error: 'AssemblyAI upload failed: ' + (e.error || uploadRes.status) });
      }

      const d = await uploadRes.json();
      res.json({ uploadUrl: d.upload_url });
    } catch (e) {
      cleanTmp(outPath);
      res.status(500).json({ error: 'Upload error: ' + e.message });
    }
  });
});

app.post('/submit-transcript', async (req, res) => {
  const { uploadUrl, assemblyaiKey } = req.body;
  if (!uploadUrl || !assemblyaiKey)
    return res.status(400).json({ error: 'uploadUrl and assemblyaiKey are required' });
  try {
    const d = await fetchJson('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: { 'authorization': assemblyaiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ audio_url: uploadUrl, speaker_labels: true }),
    });
    res.json({ transcriptId: d.id });
  } catch (e) {
    res.status(500).json({ error: 'Submit failed: ' + e.message });
  }
});

app.get('/poll-transcript', async (req, res) => {
  const { transcriptId, assemblyaiKey } = req.query;
  if (!transcriptId || !assemblyaiKey)
    return res.status(400).json({ error: 'transcriptId and assemblyaiKey are required' });
  try {
    const d = await fetchJson(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
      headers: { 'authorization': assemblyaiKey },
    });
    res.json({ status: d.status, utterances: d.utterances || [], error: d.error });
  } catch (e) {
    res.status(500).json({ error: 'Poll failed: ' + e.message });
  }
});

// Google Cloud TTS proxy — splits long text into chunks, returns array of base64 MP3 parts
app.post('/tts', async (req, res) => {
  const { text, ttsKey, voiceName, languageCode, speakingRate } = req.body;
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
        `https://texttospeech.googleapis.com/v1/text:synthesize?key=${ttsKey}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            input: { text: chunk },
            voice: {
              languageCode: languageCode || 'en-US',
              name: voiceName || 'en-US-Studio-O',
            },
            audioConfig: {
              audioEncoding: 'MP3',
              speakingRate: speakingRate || 1.0,
            },
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

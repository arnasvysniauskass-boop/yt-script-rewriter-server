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

async function doFetch(url, opts) {
  const { default: fetch } = await import('node-fetch');
  return fetch(url, opts);
}

app.get('/health', (req, res) => res.json({ ok: true }));

// Extract YouTube audio URL using cobalt.tools API, then submit to AssemblyAI
app.post('/extract-audio', async (req, res) => {
  const { youtubeUrl, assemblyaiKey } = req.body;
  if (!youtubeUrl || !assemblyaiKey)
    return res.status(400).json({ error: 'youtubeUrl and assemblyaiKey are required' });

  try {
    // Step 1: Extract video ID from YouTube URL
    const videoIdMatch = youtubeUrl.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
    if (!videoIdMatch) throw new Error('Invalid YouTube URL.');
    const videoId = videoIdMatch[1];

    // Step 2: Get audio stream URL via yt-dlp JSON API (no download, just metadata)
    // We use the YouTube audio manifest directly via a public API
    const ytApiRes = await doFetch(
      `https://www.youtube.com/youtubei/v1/player?key=AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          videoId,
          context: {
            client: {
              clientName: 'ANDROID',
              clientVersion: '19.09.37',
              androidSdkVersion: 30,
            }
          }
        }),
      }
    );

    if (!ytApiRes.ok) throw new Error('Could not fetch YouTube video info.');

    const ytData = await ytApiRes.json();
    const formats = ytData?.streamingData?.adaptiveFormats || [];
    const audioFormats = formats
      .filter(f => f.mimeType?.startsWith('audio/') && f.url)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    if (!audioFormats.length) throw new Error('No audio stream found for this video.');
    const audioUrl = audioFormats[0].url;

    // Step 2: Submit audio URL to AssemblyAI
    const d = await fetchJson('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: { 'authorization': assemblyaiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        audio_url: audioUrl,
        speaker_labels: true,
        speech_models: ['universal-2'],
      }),
    });

    res.json({ uploadUrl: audioUrl, transcriptId: d.id });
  } catch(e) {
    res.status(500).json({ error: 'Audio extraction failed: ' + e.message });
  }
});

// Submit transcript job (kept for compatibility but extract-audio now does everything)
app.post('/submit-transcript', async (req, res) => {
  const { transcriptId } = req.body;
  // Already submitted in extract-audio, just pass through
  if (transcriptId) return res.json({ transcriptId });
  res.status(400).json({ error: 'transcriptId required' });
});

// Poll transcription status
app.get('/poll-transcript', async (req, res) => {
  const { transcriptId, assemblyaiKey } = req.query;
  if (!transcriptId || !assemblyaiKey)
    return res.status(400).json({ error: 'transcriptId and assemblyaiKey are required' });
  try {
    const d = await fetchJson(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
      headers: { 'authorization': assemblyaiKey },
    });
    res.json({ status: d.status, utterances: d.utterances || [], error: d.error });
  } catch(e) {
    res.status(500).json({ error: 'Poll failed: ' + e.message });
  }
});

// Supadata transcript proxy
app.post('/get-transcript', async (req, res) => {
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
    res.json({ content: data.content || [] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Gemini TTS proxy
app.post('/tts', async (req, res) => {
  const { text, ttsKey, voiceName } = req.body;
  if (!text || !ttsKey)
    return res.status(400).json({ error: 'text and ttsKey are required' });

  const MAX_CHARS = 4500;
  const sentences = text.match(/[^.!?\n]+[.!?\n]*/g) || [text];
  const chunks = [];
  let current = '';
  for (const s of sentences) {
    if ((current + s).length > MAX_CHARS && current) { chunks.push(current.trim()); current = s; }
    else current += s;
  }
  if (current.trim()) chunks.push(current.trim());

  try {
    const audioChunks = [];
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
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName || 'Sadachbia' } } }
            }
          }),
        }
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error?.message || `Gemini TTS error ${r.status}`);
      }
      const data = await r.json();
      const audioData = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!audioData) throw new Error('No audio data returned from Gemini TTS');
      audioChunks.push(audioData);
    }
    res.json({ audioChunks });
  } catch(e) {
    res.status(500).json({ error: 'TTS failed: ' + e.message });
  }
});

const PORT = process.env.PORT || 3579;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

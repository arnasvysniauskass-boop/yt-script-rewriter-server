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

// In-memory job store for async audio processing
const audioJobs = {};

// Start audio extraction — returns jobId immediately, processes in background
app.post('/extract-audio', async (req, res) => {
  const { youtubeUrl, assemblyaiKey } = req.body;
  if (!youtubeUrl || !assemblyaiKey)
    return res.status(400).json({ error: 'youtubeUrl and assemblyaiKey are required' });

  const videoIdMatch = youtubeUrl.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  if (!videoIdMatch) return res.status(400).json({ error: 'Invalid YouTube URL.' });
  const videoId = videoIdMatch[1];

  const jobId = videoId + '_' + Date.now();
  audioJobs[jobId] = { status: 'processing', transcriptId: null, error: null };

  // Process in background without blocking the response
  processAudioJob(jobId, videoId, assemblyaiKey);

  res.json({ jobId });
});

// Poll audio job status
app.get('/audio-job', async (req, res) => {
  const { jobId } = req.query;
  const job = audioJobs[jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

async function processAudioJob(jobId, videoId, assemblyaiKey) {
  try {
    const rapidKey = process.env.RAPIDAPI_KEY;
    if (!rapidKey) throw new Error('RAPIDAPI_KEY not set on Railway.');

    // Poll RapidAPI until MP3 is ready — up to 15 min for long videos
    let audioUrl = null;
    const maxAttempts = 90; // 90 x 10s = 15 min

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(r => setTimeout(r, 10000));

      const rapidRes = await doFetch(
        `https://youtube-mp36.p.rapidapi.com/dl?id=${videoId}`,
        { headers: { 'x-rapidapi-key': rapidKey, 'x-rapidapi-host': 'youtube-mp36.p.rapidapi.com' } }
      );

      if (!rapidRes.ok) {
        console.log('RapidAPI HTTP error:', rapidRes.status);
        continue;
      }

      const rapidData = await rapidRes.json();
      console.log('RapidAPI poll', attempt + 1, ':', rapidData.status, 'progress:', rapidData.progress);

      if (rapidData.link && rapidData.status === 'ok') {
        audioUrl = rapidData.link;
        break;
      }
      if (rapidData.status === 'error' || rapidData.status === 'fail') {
        throw new Error('MP3 conversion failed: ' + (rapidData.msg || 'unknown'));
      }
    }

    if (!audioUrl) throw new Error('MP3 not ready after 15 minutes.');

    // Submit to AssemblyAI
    const d = await fetchJson('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: { 'authorization': assemblyaiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ audio_url: audioUrl, speaker_labels: true, speech_models: ['universal-2'] }),
    });

    audioJobs[jobId] = { status: 'done', transcriptId: d.id, error: null };
    console.log('Audio job done, transcriptId:', d.id);
  } catch(e) {
    console.log('Audio job error:', e.message);
    audioJobs[jobId] = { status: 'error', transcriptId: null, error: e.message };
  }
}

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

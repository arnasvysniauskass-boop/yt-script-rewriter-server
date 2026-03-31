const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

function cleanTmp(filePath) {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch(e) {}
}

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

// In-memory job store
const audioJobs = {};

// Start audio extraction job — returns jobId immediately
app.post('/extract-audio', async (req, res) => {
  const { youtubeUrl, assemblyaiKey } = req.body;
  if (!youtubeUrl || !assemblyaiKey)
    return res.status(400).json({ error: 'youtubeUrl and assemblyaiKey are required' });

  const videoIdMatch = youtubeUrl.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  if (!videoIdMatch) return res.status(400).json({ error: 'Invalid YouTube URL.' });
  const videoId = videoIdMatch[1];

  const jobId = videoId + '_' + Date.now();
  audioJobs[jobId] = { status: 'processing', transcriptId: null, error: null };

  // Run in background
  processAudioJob(jobId, videoId, assemblyaiKey);

  res.json({ jobId });
});

// Poll audio job status
app.get('/audio-job', (req, res) => {
  const { jobId } = req.query;
  const job = audioJobs[jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

async function processAudioJob(jobId, videoId, assemblyaiKey) {
  try {
    const rapidKey = process.env.RAPIDAPI_KEY;
    if (!rapidKey) throw new Error('RAPIDAPI_KEY not set on Railway.');

    console.log(`[${jobId}] Starting audio conversion for video ${videoId}`);

    let audioUrl = null;
    const maxAttempts = 90; // 15 min max

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(r => setTimeout(r, 10000));

      const rapidRes = await doFetch(
        `https://youtube-mp36.p.rapidapi.com/dl?id=${videoId}`,
        { headers: { 'x-rapidapi-key': rapidKey, 'x-rapidapi-host': 'youtube-mp36.p.rapidapi.com' } }
      );

      if (!rapidRes.ok) {
        console.log(`[${jobId}] RapidAPI HTTP error: ${rapidRes.status}`);
        if (rapidRes.status === 403) {
          throw new Error('RapidAPI 403: Check your RAPIDAPI_KEY and subscription to youtube-mp36.');
        }
        continue;
      }

      const data = await rapidRes.json();
      console.log(`[${jobId}] Poll ${attempt + 1}: status=${data.status} progress=${data.progress}`);

      if (data.link && data.status === 'ok') {
        audioUrl = data.link;
        break;
      }
      if (data.status === 'error' || data.status === 'fail') {
        throw new Error('MP3 conversion failed: ' + (data.msg || 'unknown'));
      }
    }

    if (!audioUrl) throw new Error('MP3 not ready after 15 minutes. Try a shorter video.');

    console.log(`[${jobId}] Got audio URL, submitting to AssemblyAI...`);

    const d = await fetchJson('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: { 'authorization': assemblyaiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        audio_url: audioUrl,
        speaker_labels: true,
        speech_models: ['universal-2'],
      }),
    });

    audioJobs[jobId] = { status: 'done', transcriptId: d.id, error: null };
    console.log(`[${jobId}] Done. transcriptId: ${d.id}`);
  } catch(e) {
    console.log(`[${jobId}] Error: ${e.message}`);
    audioJobs[jobId] = { status: 'error', transcriptId: null, error: e.message };
  }
}

// Poll AssemblyAI transcript status
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

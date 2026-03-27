#!/bin/bash
set -e
echo "Installing Python3..."
apt-get update -qq && apt-get install -y python3 python3-pip ffmpeg 2>/dev/null || \
  (apk add --no-cache python3 py3-pip ffmpeg 2>/dev/null || true)
echo "Installing yt-dlp..."
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp
echo "yt-dlp installed: $(yt-dlp --version)"

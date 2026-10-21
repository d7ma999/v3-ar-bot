FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip && \
    pip3 install yt-dlp --break-system-packages
WORKDIR /app
COPY . .
RUN npm install
CMD ["node", "index.js"]

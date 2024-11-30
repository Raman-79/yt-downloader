FROM node:20-alpine

# Install system dependencies, FFmpeg, Python, and yt-dlp
RUN apk update && \
    apk add --no-cache \
    ffmpeg \
    python3 \
    py3-pip && \
    pip3 install --break-system-packages yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run build

EXPOSE 3000

CMD ["npm", "run","dev"]
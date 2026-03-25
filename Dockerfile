# ── ToolFlow PDF Backend ──
# Includes: Node.js 20, LibreOffice, poppler-utils, ghostscript, qpdf, Chromium

FROM node:20-bullseye-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    libreoffice \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    poppler-utils \
    ghostscript \
    qpdf \
    chromium \
    fonts-liberation \
    fonts-dejavu \
    fontconfig \
    --no-install-recommends \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set Puppeteer to use installed Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies (including puppeteer)
RUN npm install && npm install puppeteer --save

# Copy app source
COPY . .

# Create tmp directory
RUN mkdir -p tmp && chmod 777 tmp

EXPOSE 3000

CMD ["node", "server.js"]

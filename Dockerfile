FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

COPY package*.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && pip3 install --no-cache-dir msoffcrypto-tool \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV FRESHON_HEADLESS=true

EXPOSE 3000

CMD ["npm", "start"]

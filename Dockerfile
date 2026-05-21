FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV FRESHON_HEADLESS=true

EXPOSE 3000

CMD ["npm", "start"]

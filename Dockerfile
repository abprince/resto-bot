FROM node:18-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --only=production

COPY . .

RUN mkdir -p auth_info_baileys

EXPOSE 3000

CMD ["node", "bot.js"]
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

RUN mkdir -p auth_info_baileys

EXPOSE 3000

CMD ["node", "bot.js"]
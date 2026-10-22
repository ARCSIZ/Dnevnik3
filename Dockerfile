FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY index.html login.html diary.html chat.html studio.html zhurnal.html STplus.html server.js sw.js theme.css theme.js manifest.webmanifest icon-192.png icon-512.png apple-touch-icon.png og-image.png splash.js ./

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV DATA_FILE=/app/data/data.json

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "server.js"]
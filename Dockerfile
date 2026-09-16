FROM node:22-alpine

WORKDIR /app

# Install deps first so this layer is cached unless package files change.
COPY package.json package-lock.json* ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "run", "start"]

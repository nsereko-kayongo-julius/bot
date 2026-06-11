FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY . .

# Run the entry script directly
CMD ["node", "index.js"]

FROM node:20-alpine

WORKDIR /app

# Copy package files first — this layer is cached unless dependencies change
COPY package.json ./

# Install dependencies (cached unless package.json changes)
RUN npm install

# Copy the rest of the code
COPY . .

EXPOSE 3579

CMD ["node", "index.js"]

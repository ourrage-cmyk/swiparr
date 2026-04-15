# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Build arguments for environment variables
ARG VITE_SERVER_URL
ARG VITE_USER_1_NAME
ARG VITE_USER_1_API_KEY
ARG VITE_USER_2_NAME
ARG VITE_USER_2_API_KEY
ARG VITE_USER_3_NAME
ARG VITE_USER_3_API_KEY
ARG VITE_USER_4_NAME
ARG VITE_USER_4_API_KEY
ARG VITE_USER_5_NAME
ARG VITE_USER_5_API_KEY

# Set environment variables for build
ENV VITE_SERVER_URL=$VITE_SERVER_URL
ENV VITE_USER_1_NAME=$VITE_USER_1_NAME
ENV VITE_USER_1_API_KEY=$VITE_USER_1_API_KEY
ENV VITE_USER_2_NAME=$VITE_USER_2_NAME
ENV VITE_USER_2_API_KEY=$VITE_USER_2_API_KEY
ENV VITE_USER_3_NAME=$VITE_USER_3_NAME
ENV VITE_USER_3_API_KEY=$VITE_USER_3_API_KEY
ENV VITE_USER_4_NAME=$VITE_USER_4_NAME
ENV VITE_USER_4_API_KEY=$VITE_USER_4_API_KEY
ENV VITE_USER_5_NAME=$VITE_USER_5_NAME
ENV VITE_USER_5_API_KEY=$VITE_USER_5_API_KEY

# Copy package files
COPY package*.json ./

# Install dependencies
RUN rm -f package-lock.json && npm install

# Copy source code
COPY . .

# Build the app
RUN npm run build

# Production stage — xenova/transformers uses WASM, no native bindings needed
FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY server ./server

EXPOSE 80

CMD ["node", "server/index.js"]

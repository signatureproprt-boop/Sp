FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY . .
RUN mkdir -p assets/pdfjs && \
    cp node_modules/pdfjs-dist/build/pdf.mjs node_modules/pdfjs-dist/build/pdf.worker.mjs assets/pdfjs/ && \
    cp -R node_modules/pdfjs-dist/standard_fonts assets/pdfjs/standard_fonts && \
    cp node_modules/pdfjs-dist/LICENSE assets/pdfjs/LICENSE
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.js"]

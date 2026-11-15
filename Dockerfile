# Mock server image. Serves /mocks on port 8181; the Petstore demo is built in as default.
#   docker run --rm -p 8181:8181 mockserver                          # the demo
#   docker run --rm -p 8181:8181 -v "$PWD/mocks:/mocks" mockserver   # your mocks
#   docker run --rm -p 8181:8181 -v "$PWD/mocks:/mocks" mockserver -t https://api.example.com -r true
# Extra arguments are added to the mockserver options (later options win).
FROM node:24.22.3-alpine3.24

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY mockserver.js generate-mock-structure.js ./
COPY lib ./lib
COPY --chown=node:node demo/mocks /mocks

USER node
EXPOSE 8181
ENTRYPOINT ["node", "/app/mockserver.js", "-H", "0.0.0.0", "-m", "/mocks"]

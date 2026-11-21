FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
RUN apk add --no-cache openssl
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY locations.conf /etc/nginx/multivision/locations.conf
COPY --chmod=755 10-certificate.sh /docker-entrypoint.d/10-certificate.sh
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80 443

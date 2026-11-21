#!/bin/sh
# Run by the nginx image at start (/docker-entrypoint.d): create a self-signed
# certificate once and keep it in the web-certs volume, so a phone that accepted it
# keeps trusting it. Extra names/IPs for the certificate: CERT_HOSTS="192.168.1.20 my-pc".
set -e
dir=/etc/nginx/certs
[ -s "$dir/multivision.crt" ] && [ -s "$dir/multivision.key" ] && exit 0
mkdir -p "$dir"
san="DNS:localhost,IP:127.0.0.1"
for h in $CERT_HOSTS; do
  case "$h" in
    *[!0-9.]*) san="$san,DNS:$h" ;;
    *) san="$san,IP:$h" ;;
  esac
done
openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
  -keyout "$dir/multivision.key" -out "$dir/multivision.crt" \
  -subj "/CN=MultiVision AI Manager" -addext "subjectAltName=$san" 2>/dev/null
echo "10-certificate.sh: created a self-signed certificate ($san)"

#!/bin/sh
# Run by the nginx image at start (/docker-entrypoint.d). Enables HTTPS (port 443) with
# a self-signed certificate, created once and kept in the web-certs volume so a phone
# that accepted it keeps trusting it. Extra names/IPs: CERT_HOSTS="192.168.1.20 my-pc".
# Never fails: without a certificate the site still runs on HTTP.
dir=/etc/nginx/certs
if [ ! -s "$dir/multivision.crt" ] || [ ! -s "$dir/multivision.key" ]; then
  mkdir -p "$dir"
  san="DNS:localhost,IP:127.0.0.1"
  for h in $CERT_HOSTS; do
    case "$h" in
      *[!0-9.]*) san="$san,DNS:$h" ;;
      *) san="$san,IP:$h" ;;
    esac
  done
  if openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
      -keyout "$dir/multivision.key" -out "$dir/multivision.crt" \
      -subj "/CN=MultiVision AI Manager" -addext "subjectAltName=$san" >/dev/null 2>&1; then
    echo "10-certificate.sh: created a self-signed certificate ($san)"
  else
    echo "10-certificate.sh: could not create a certificate; HTTPS disabled, HTTP still works"
    rm -f "$dir/multivision.crt" "$dir/multivision.key"
  fi
fi
if [ -s "$dir/multivision.crt" ] && [ -s "$dir/multivision.key" ]; then
  cp /etc/nginx/multivision/https.conf /etc/nginx/conf.d/https.conf
  echo "10-certificate.sh: HTTPS enabled on port 443"
fi
exit 0

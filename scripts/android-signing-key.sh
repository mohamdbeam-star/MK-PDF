#!/bin/zsh
# One-time setup: creates MK PDF's permanent Android signing key and stores it as GitHub Actions secrets, so
# every release APK installs over the previous one. Keep ~/Documents/MKPDF-keys safe (e.g. in your password
# manager): with a different key, Android refuses to update the app and it must be uninstalled first.
set -euo pipefail
REPO=mohamdbeam-star/MK-PDF
DIR=~/Documents/MKPDF-keys
mkdir -p "$DIR" && cd "$DIR"
[[ -f mkpdf-android.p12 ]] && { echo "A key already exists in $DIR; not replacing it."; exit 1; }
PW=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)
openssl req -x509 -newkey rsa:2048 -nodes -days 10000 -subj "/CN=MK PDF/O=MK PDF" -keyout key.pem -out cert.pem 2>/dev/null
openssl pkcs12 -export -inkey key.pem -in cert.pem -name mkpdf -out mkpdf-android.p12 -passout "pass:$PW"
rm key.pem cert.pem
print -r -- "$PW" > mkpdf-android.password.txt
chmod 600 mkpdf-android.p12 mkpdf-android.password.txt
gh auth switch -h github.com -u "${REPO%%/*}" >/dev/null
base64 -i mkpdf-android.p12 | gh secret set ANDROID_KEYSTORE_B64 -R "$REPO"
print -rn -- "$PW" | gh secret set ANDROID_KEYSTORE_PASSWORD -R "$REPO"
print -rn -- mkpdf | gh secret set ANDROID_KEY_ALIAS -R "$REPO"
print -rn -- "$PW" | gh secret set ANDROID_KEY_PASSWORD -R "$REPO"
echo "Done. Key and password saved in $DIR; the four ANDROID_* secrets are set on $REPO."

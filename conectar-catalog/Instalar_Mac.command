#!/bin/bash
# Prepara o Mac pro Conectar_Catalog. So precisa ser feito uma vez.
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo ""
echo "  Preparando este Mac. So precisa ser feito uma vez."
echo "  Pode levar alguns minutos."
echo ""

if ! command -v python3 >/dev/null 2>&1; then
  echo "  Python 3 nao foi encontrado neste Mac."
  echo "  Rode 'xcode-select --install' no Terminal, ou baixe em python.org,"
  echo "  e clique aqui de novo."
  echo ""
  read -r -p "Pressione Enter para fechar..." _
  exit 1
fi

[ -d venv ] || python3 -m venv venv
./venv/bin/pip install --upgrade pip -q
./venv/bin/pip install -r requirements.txt -q
./venv/bin/python -m playwright install chromium

echo ""
echo "  Pronto. Agora use o \"Conectar_Catalog\"."
echo ""
read -r -p "Pressione Enter para fechar..." _

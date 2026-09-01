#!/bin/bash
# Conectar minha conta do Catalog -- macOS. Duplo clique no Finder.
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

if [ ! -x "$DIR/venv/bin/python" ]; then
  echo ""
  echo "  Este Mac ainda nao esta preparado."
  echo "  Clique primeiro no \"Instalar_Mac.command\", nesta mesma pasta."
  echo ""
  read -r -p "Pressione Enter para fechar..." _
  exit 1
fi

"$DIR/venv/bin/python" conectar_catalog.py

echo ""
read -r -p "(Essa janela so fecha quando voce apertar Enter.) " _

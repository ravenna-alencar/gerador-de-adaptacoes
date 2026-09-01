@echo off
title Conectar minha conta do Catalog
cd /d "%~dp0"

if not exist "venv\Scripts\python.exe" (
  echo.
  echo   Este computador ainda nao esta preparado.
  echo   Clique primeiro no "Instalar_Windows", que fica nesta mesma pasta.
  echo.
  pause
  exit /b 1
)

venv\Scripts\python.exe conectar_catalog.py
echo.
echo (Essa janela so fecha quando voce apertar uma tecla.)
pause

#!/bin/bash

echo "------------------------------------------"
echo "   Youtube Hero - Management Launcher"
echo "------------------------------------------"
echo "1) Launch Game (Electron)"
echo "2) Run AI Parameter Optimization"
echo "3) Build Linux AppImage"
echo "4) Build Windows Executable (Requires Wine)"
echo "5) Exit"
echo "------------------------------------------"
read -p "Select an option [1-5]: " choice

case $choice in
    1)
        echo "Starting game..."
        ELECTRON_ENABLE_LOGGING=1 npm start 2>&1 | grep --line-buffered -v -E "Fontconfig warning|GLib-GObject|gl_surface_presentation_helper.cc|browser_main_loop.cc"
        ;;
    2)
        echo "Launching AI Optimization script..."
        ./venv/bin/python ai_trainer/optimize_maps.py
        ;;
    3)
        echo "Building Linux AppImage..."
        if [ ! -d "node_modules/electron-builder" ]; then
            echo "Installing build dependencies..."
            npm install
        fi
        npm run dist:linux
        ;;
    4)
        echo "Building Windows Executable..."
        if [ ! -d "node_modules/electron-builder" ]; then
            echo "Installing build dependencies..."
            npm install
        fi
        npm run dist:win
        ;;
    5)
        echo "Exiting."
        exit 0
        ;;
    *)
        echo "Invalid option. Exiting."
        exit 1
        ;;
esac

# Gio

An AI DJ + voice assistant that's always running. The music is AI-generated through Gemini Lyria and the assistant is Gemini Live. They're connected so that the music fades away while you talk with the assistant, and then comes back after. Music is automatically tuned to whatever you're working on. Music is tunable on your own and can be controlled through the popup window, which also has the assistant.

Use the mcp/ branch for the MCP-enabled agent! Responses might be slower.

backend runs on port 5000 frontend on port 5173

# Setup

in frontend/
```
npm i
npm run dev
```

in backend/
create a venv/conda if you want
```
pip install -r requirements.txt
python -m app
```

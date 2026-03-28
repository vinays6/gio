# Flask OAuth Backend

## Setup
1. Copy `.env.example` to `.env` and fill in Google OAuth credentials.
2. Install dependencies:
   ```sh
   pip install -r requirements.txt
   ```
3. Run the backend:
   ```sh
   cd app
   python run.py
   ```

The backend runs on port 5000.

## API
- `GET /login`: Initiate OAuth login with Google.
- `/authorize`: Google redirects here.
- `GET /api/user`: Returns logged-in user info.
- `POST /api/user/preferences`: Set user preferences (JSON body: `{ "preferences": "string" }`).

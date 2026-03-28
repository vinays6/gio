from flask import Blueprint, request, jsonify, session, redirect, url_for
from .models import db, User
from authlib.integrations.flask_client import OAuth
from flask import current_app as app
import os

api_bp = Blueprint('api', __name__)

# OAuth config (you must set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your environment)
oauth = OAuth()
google = oauth.register(
    name='google',
    client_id=os.getenv('GOOGLE_CLIENT_ID'),
    client_secret=os.getenv('GOOGLE_CLIENT_SECRET'),
    server_metadata_url='https://accounts.google.com/.well-known/openid-configuration',
    api_base_url='https://www.googleapis.com/oauth2/v1/',
    client_kwargs={
        'scope': 'openid email profile'
    }
)

@api_bp.record_once
def on_load(state):
    oauth.init_app(state.app)
    
@api_bp.route('/login')
def login():
    frontend_url = os.getenv('FRONTEND_URL', 'http://localhost:5173/')
    redirect_uri = frontend_url.rstrip('/') + '/authorize'
    return google.authorize_redirect(redirect_uri)

from authlib.integrations.base_client.errors import MismatchingStateError

@api_bp.route('/authorize')
def authorize():
    try:
        token = google.authorize_access_token()
    except MismatchingStateError:
        return redirect('/login')
    except Exception as e:
        return jsonify({'error': str(e)}), 400

    resp = google.get('userinfo')
    user_info = resp.json()
    email = user_info['email']
    user = User.query.filter_by(email=email).first()
    if not user:
        user = User(email=email, name=user_info.get('name'))
        db.session.add(user)
        db.session.commit()
    session['user'] = user.id
    frontend_url = os.getenv('FRONTEND_URL', 'http://localhost:5173/')
    return redirect(frontend_url)

@api_bp.route('/api/user', methods=['GET'])
def get_user():
    user_id = session.get('user')
    if not user_id:
        return jsonify({'error': 'Not logged in'}), 401
    user = User.query.get(user_id)
    if not user:
        return jsonify({'error': 'User not found'}), 404
    return jsonify({'email': user.email, 'name': user.name, 'preferences': user.preferences})

@api_bp.route('/api/user/preferences', methods=['POST'])
def set_preferences():
    user_id = session.get('user')
    if not user_id:
        return jsonify({'error': 'Not logged in'}), 401
    preferences = request.json.get('preferences')
    user = User.query.get(user_id)
    if not user:
        return jsonify({'error': 'User not found'}), 404
    user.preferences = preferences
    db.session.commit()
    return jsonify({'success': True, 'preferences': preferences})

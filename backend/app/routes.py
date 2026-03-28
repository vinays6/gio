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
    access_token_url='https://oauth2.googleapis.com/token',
    access_token_params=None,
    authorize_url='https://accounts.google.com/o/oauth2/auth',
    authorize_params=None,
    api_base_url='https://www.googleapis.com/oauth2/v1/',
    client_kwargs={'scope': 'openid email profile'}
)

@api_bp.record_once
def on_load(state):
    oauth.init_app(state.app)
    
@api_bp.route('/login')
def login():
    redirect_uri = url_for('.authorize', _external=True)
    return google.authorize_redirect(redirect_uri)

@api_bp.route('/authorize')
def authorize():
    token = google.authorize_access_token()
    resp = google.get('userinfo')
    user_info = resp.json()
    email = user_info['email']
    user = User.query.filter_by(email=email).first()
    if not user:
        user = User(email=email, name=user_info.get('name'))
        db.session.add(user)
        db.session.commit()
    session['user'] = user.id
    return redirect('/')

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

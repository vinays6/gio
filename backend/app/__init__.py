from flask import Flask
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv()

from .models import db

def create_app():
    app = Flask(__name__)
    app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///users.db'
    app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
    app.secret_key = 'dev-secret-key-change-in-prod'
    db.init_app(app)
    CORS(app, supports_credentials=True)
    
    with app.app_context():
        db.create_all()
    
    from .routes import api_bp
    app.register_blueprint(api_bp)
    
    return app

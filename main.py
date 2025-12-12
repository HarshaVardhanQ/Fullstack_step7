# main.py
import logging
from typing import Optional
from datetime import datetime, timedelta

from fastapi import FastAPI, Depends, HTTPException, status, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel, Field
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, RedirectResponse

from jose import jwt, JWTError
from passlib.context import CryptContext

from sqlalchemy import Column, Integer, String, select
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker, declarative_base

# ---------- Config ----------
DATABASE_URL = "sqlite+aiosqlite:///./app.db"
SECRET_KEY = "supersecretkey_change_me"  # set via env var in production
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60

# ---------- Logging ----------
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ---------- DB ----------
engine = create_async_engine(DATABASE_URL, echo=False)
Base = declarative_base()
async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

class AuthUser(Base):
    __tablename__ = "auth_users"
    id = Column(Integer, primary_key=True)
    username = Column(String, unique=True, index=True)
    hashed_password = Column(String)

class Person(Base):
    __tablename__ = "persons"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    roll = Column(String, nullable=False)   # could be numeric, keep string for flexibility
    age = Column(Integer, nullable=False)
    gender = Column(String, nullable=False)

    def to_dict(self):
        return {"id": self.id, "name": self.name, "roll": self.roll, "age": self.age, "gender": self.gender}

async def get_db():
    async with async_session() as session:
        yield session

# ---------- Security ----------
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")

def truncate_password(password: str) -> str:
    return password[:72]

def get_password_hash(password: str) -> str:
    try:
        password = truncate_password(password)
        return pwd_context.hash(password)
    except Exception as exc:
        logger.exception("Password hashing failed")
        raise HTTPException(status_code=500, detail="Server-side hashing error") from exc

def verify_password(plain_password: str, hashed_password: str) -> bool:
    plain_password = truncate_password(plain_password)
    try:
        return pwd_context.verify(plain_password, hashed_password)
    except Exception:
        logger.exception("Password verify failed")
        return False

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

async def get_current_user(token: str = Depends(oauth2_scheme)):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid authentication credentials",
        headers={"WWW-Authenticate": "Bearer"}
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
        return username
    except JWTError:
        raise credentials_exception

async def authenticate_user(db: AsyncSession, username: str, password: str):
    result = await db.execute(select(AuthUser).where(AuthUser.username == username))
    user = result.scalars().first()
    if not user:
        return False
    if not verify_password(password, user.hashed_password):
        return False
    return user

# ---------- FastAPI app ----------
app = FastAPI(title="People Manager")

# (Optional) keep CORS for API clients; same-origin frontend won't need it
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static files at /static
app.mount("/static", StaticFiles(directory="static", html=True), name="static")

@app.get("/", include_in_schema=False)
async def root():
    return RedirectResponse(url="/static/index.html")

# ---------- Pydantic schemas ----------
class AuthSchema(BaseModel):
    username: str = Field(..., min_length=1)
    password: str = Field(..., min_length=1)

class PersonCreate(BaseModel):
    name: str = Field(..., min_length=1)
    roll: str = Field(..., min_length=1)
    age: int = Field(..., ge=0)
    gender: str = Field(..., min_length=1)

class PersonUpdate(BaseModel):
    name: Optional[str]
    roll: Optional[str]
    age: Optional[int]
    gender: Optional[str]

# ---------- Startup ----------
@app.on_event("startup")
async def startup():
    logger.info("Creating DB tables (if not exist)")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

# ---------- Auth endpoints ----------
@app.post("/auth/signup")
async def signup(auth: AuthSchema, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(AuthUser).where(AuthUser.username == auth.username))
    existing = result.scalars().first()
    if existing:
        raise HTTPException(status_code=400, detail="Username already exists")
    hashed = get_password_hash(auth.password)
    new = AuthUser(username=auth.username, hashed_password=hashed)
    db.add(new)
    await db.commit()
    await db.refresh(new)
    return {"detail": "User created", "username": new.username}

@app.post("/auth/login")
async def login(auth: AuthSchema, db: AsyncSession = Depends(get_db)):
    user = await authenticate_user(db, auth.username, auth.password)
    if not user:
        raise HTTPException(status_code=401, detail="Incorrect username or password")
    token = create_access_token({"sub": user.username})
    return {"access_token": token, "token_type": "bearer"}

# ---------- Person CRUD (protected) ----------
@app.post("/persons")
async def create_person(p: PersonCreate, db: AsyncSession = Depends(get_db), current_user: str = Depends(get_current_user)):
    new = Person(name=p.name, roll=p.roll, age=p.age, gender=p.gender)
    db.add(new)
    await db.commit()
    await db.refresh(new)
    return {"message": "Person created", "data": new.to_dict()}

@app.get("/persons")
async def list_persons(
    search: Optional[str] = Query(None),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1),
    db: AsyncSession = Depends(get_db),
    current_user: str = Depends(get_current_user)
):
    q = select(Person)
    if search:
        q = q.where(Person.name.ilike(f"%{search}%"))
    result = await db.execute(q.offset(skip).limit(limit))
    items = result.scalars().all()
    return {"items": [i.to_dict() for i in items], "skip": skip, "limit": limit}

@app.get("/persons/{person_id}")
async def get_person(person_id: int, db: AsyncSession = Depends(get_db), current_user: str = Depends(get_current_user)):
    result = await db.execute(select(Person).where(Person.id == person_id))
    person = result.scalars().first()
    if not person:
        raise HTTPException(status_code=404, detail="Person not found")
    return person.to_dict()

@app.put("/persons/{person_id}")
async def put_person(person_id: int, p: PersonCreate, db: AsyncSession = Depends(get_db), current_user: str = Depends(get_current_user)):
    result = await db.execute(select(Person).where(Person.id == person_id))
    person = result.scalars().first()
    if not person:
        raise HTTPException(status_code=404, detail="Person not found")
    person.name = p.name
    person.roll = p.roll
    person.age = p.age
    person.gender = p.gender
    await db.commit()
    await db.refresh(person)
    return {"message": "Person updated", "data": person.to_dict()}

@app.patch("/persons/{person_id}")
async def patch_person(person_id: int, patch: PersonUpdate, db: AsyncSession = Depends(get_db), current_user: str = Depends(get_current_user)):
    result = await db.execute(select(Person).where(Person.id == person_id))
    person = result.scalars().first()
    if not person:
        raise HTTPException(status_code=404, detail="Person not found")
    data = patch.dict(exclude_unset=True)
    for k, v in data.items():
        setattr(person, k, v)
    await db.commit()
    await db.refresh(person)
    return {"message": "Person partially updated", "data": person.to_dict()}

@app.delete("/persons/{person_id}")
async def delete_person(person_id: int, db: AsyncSession = Depends(get_db), current_user: str = Depends(get_current_user)):
    result = await db.execute(select(Person).where(Person.id == person_id))
    person = result.scalars().first()
    if not person:
        raise HTTPException(status_code=404, detail="Person not found")
    await db.delete(person)
    await db.commit()
    return {"message": "Person deleted", "data": person.to_dict()}

# ---------- Global error handler ----------
@app.exception_handler(Exception)
async def generic_exception_handler(request, exc):
    logger.exception("Unhandled exception: %s", exc)
    return JSONResponse(status_code=500, content={"detail": "Internal Server Error"})

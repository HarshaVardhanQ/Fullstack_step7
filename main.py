# main.py
import logging
import os
from typing import Optional
from datetime import datetime, timedelta
from contextlib import asynccontextmanager
from collections import defaultdict

from fastapi import FastAPI, Depends, HTTPException, status, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel, Field
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, RedirectResponse

from jose import jwt, JWTError
from passlib.context import CryptContext

from sqlalchemy import (
    Column,
    Integer,
    String,
    select,
    ForeignKey,
    func,
    text,
)
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker, declarative_base, relationship

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
    persons = relationship("Person", back_populates="owner")


class Person(Base):
    __tablename__ = "persons"
    id = Column(Integer, primary_key=True, index=True)  # global id
    user_person_id = Column(Integer, nullable=True)  # per-user sequential id
    name = Column(String, nullable=False)
    roll = Column(String, nullable=False)
    age = Column(Integer, nullable=False)
    gender = Column(String, nullable=False)
    owner_id = Column(Integer, ForeignKey("auth_users.id"), nullable=True)

    owner = relationship("AuthUser", back_populates="persons")

    def to_dict(self):
        return {
            "id": self.id,
            "user_person_id": self.user_person_id,
            "name": self.name,
            "roll": self.roll,
            "age": self.age,
            "gender": self.gender,
            "owner_id": self.owner_id,
        }


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


async def get_current_user(db: AsyncSession = Depends(get_db), token: str = Depends(oauth2_scheme)) -> AuthUser:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid authentication credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    result = await db.execute(select(AuthUser).where(AuthUser.username == username))
    user = result.scalars().first()
    if not user:
        raise credentials_exception
    return user


async def authenticate_user(db: AsyncSession, username: str, password: str):
    result = await db.execute(select(AuthUser).where(AuthUser.username == username))
    user = result.scalars().first()
    if not user:
        return False
    if not verify_password(password, user.hashed_password):
        return False
    return user


# ---------- FastAPI app with lifespan for safe migrations ----------
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("LIFESPAN startup: creating tables and ensuring columns (no blind ownership backfill).")
    async with engine.begin() as conn:
        # create tables if missing
        await conn.run_sync(Base.metadata.create_all)

        # migration: add missing columns (owner_id, user_person_id) if they don't exist;
        # do not reassign owner_id for existing rows (to avoid accidentally making one user own everything).
        def _migrate(sync_conn):
            try:
                rows = sync_conn.execute(text("PRAGMA table_info(persons)")).fetchall()
            except Exception:
                rows = []
            cols = [r[1] for r in rows]  # column name is at index 1
            statements = []
            if "owner_id" not in cols:
                statements.append("ALTER TABLE persons ADD COLUMN owner_id INTEGER;")
            if "user_person_id" not in cols:
                statements.append("ALTER TABLE persons ADD COLUMN user_person_id INTEGER;")

            for s in statements:
                try:
                    logger.info("Running migration SQL: %s", s)
                    sync_conn.execute(text(s))
                except Exception:
                    logger.exception("Failed migration SQL: %s", s)

            # Backfill user_person_id only for rows that already have owner_id set (do NOT set owner_id)
            if "user_person_id" not in cols:
                try:
                    # get owners that exist
                    owners = sync_conn.execute(text("SELECT DISTINCT owner_id FROM persons WHERE owner_id IS NOT NULL ORDER BY owner_id")).fetchall()
                    owners = [o[0] for o in owners if o[0] is not None]
                    for owner_id in owners:
                        rows_for_owner = sync_conn.execute(
                            text("SELECT id FROM persons WHERE owner_id = :oid ORDER BY id"),
                            {"oid": owner_id},
                        ).fetchall()
                        cnt = 0
                        for (pid,) in rows_for_owner:
                            cnt += 1
                            sync_conn.execute(
                                text("UPDATE persons SET user_person_id = :num WHERE id = :rid"),
                                {"num": cnt, "rid": pid},
                            )
                    logger.info("Backfilled user_person_id for owners present in DB.")
                except Exception:
                    logger.exception("Failed to backfill user_person_id")

        await conn.run_sync(_migrate)

    logger.info("LIFESPAN startup done")
    yield
    logger.info("LIFESPAN shutdown")


app = FastAPI(title="People Manager", lifespan=lifespan)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static files at /static (ensure directory exists)
os.makedirs("static", exist_ok=True)
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


# ---------- Person CRUD (owner-scoped, per-user numbering) ----------
@app.post("/persons")
async def create_person(p: PersonCreate, db: AsyncSession = Depends(get_db), current_user: AuthUser = Depends(get_current_user)):
    result = await db.execute(select(func.max(Person.user_person_id)).where(Person.owner_id == current_user.id))
    max_val = result.scalar()
    next_user_person_id = (max_val or 0) + 1

    new = Person(
        user_person_id=next_user_person_id,
        name=p.name,
        roll=p.roll,
        age=p.age,
        gender=p.gender,
        owner_id=current_user.id,
    )
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
    current_user: AuthUser = Depends(get_current_user),
):
    q = select(Person).where(Person.owner_id == current_user.id)
    if search:
        q = q.where(func.lower(Person.name).like(f"%{search.strip().lower()}%"))
    # prefer ordering by per-user id (if present)
    lookup_pref = _lookup_column()
    if lookup_pref is not None:
        q = q.order_by(lookup_pref)
    else:
        q = q.order_by(Person.id)
    result = await db.execute(q.offset(skip).limit(limit))
    items = result.scalars().all()
    return {"items": [i.to_dict() for i in items], "skip": skip, "limit": limit}


def _lookup_column():
    """Helper to choose lookup column: prefer user_person_id when available, else id.
       Always returns a SQLAlchemy column object."""
    col = getattr(Person, "user_person_id", None)
    return col if col is not None else Person.id


@app.get("/persons/{person_id}")
async def get_person(person_id: int, db: AsyncSession = Depends(get_db), current_user: AuthUser = Depends(get_current_user)):
    lookup_col = _lookup_column()
    result = await db.execute(select(Person).where(lookup_col == person_id, Person.owner_id == current_user.id))
    person = result.scalars().first()
    if not person:
        raise HTTPException(status_code=404, detail="Person not found")
    return person.to_dict()


@app.put("/persons/{person_id}")
async def put_person(person_id: int, p: PersonCreate, db: AsyncSession = Depends(get_db), current_user: AuthUser = Depends(get_current_user)):
    lookup_col = _lookup_column()
    result = await db.execute(select(Person).where(lookup_col == person_id, Person.owner_id == current_user.id))
    person = result.scalars().first()
    if not person:
        raise HTTPException(status_code=404, detail="Person not found")

    # update safe fields only
    person.name = p.name
    person.roll = p.roll
    person.age = p.age
    person.gender = p.gender

    await db.commit()
    await db.refresh(person)
    return {"message": "Person updated", "data": person.to_dict()}


@app.patch("/persons/{person_id}")
async def patch_person(person_id: int, patch: PersonUpdate, db: AsyncSession = Depends(get_db), current_user: AuthUser = Depends(get_current_user)):
    lookup_col = _lookup_column()
    result = await db.execute(select(Person).where(lookup_col == person_id, Person.owner_id == current_user.id))
    person = result.scalars().first()
    if not person:
        raise HTTPException(status_code=404, detail="Person not found")

    data = patch.dict(exclude_unset=True)
    if not data:
        raise HTTPException(status_code=400, detail="No fields provided for update")

    protected = {"id", "owner_id", "user_person_id"}
    updated = False
    for k, v in data.items():
        if k in protected:
            raise HTTPException(status_code=400, detail=f"Cannot update protected field: {k}")
        if not hasattr(person, k):
            logger.warning("Attempt to update unknown attribute '%s' on Person", k)
            continue
        setattr(person, k, v)
        updated = True

    if not updated:
        raise HTTPException(status_code=400, detail="No valid fields provided to update")

    try:
        await db.commit()
        await db.refresh(person)
    except Exception:
        logger.exception("Failed to commit PATCH /persons/%s", person_id)
        raise HTTPException(status_code=500, detail="Failed to update person")

    return {"message": "Person partially updated", "data": person.to_dict()}


@app.delete("/persons/{person_id}")
async def delete_person(person_id: int, db: AsyncSession = Depends(get_db), current_user: AuthUser = Depends(get_current_user)):
    lookup_col = _lookup_column()
    result = await db.execute(select(Person).where(lookup_col == person_id, Person.owner_id == current_user.id))
    person = result.scalars().first()
    if not person:
        raise HTTPException(status_code=404, detail="Person not found")
    await db.delete(person)
    await db.commit()
    return {"message": "Person deleted", "data": person.to_dict()}


# ---------- Global error handler ----------
from fastapi import HTTPException as FastAPIHTTPException


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    # pass through HTTPExceptions (preserve status and headers)
    if isinstance(exc, FastAPIHTTPException):
        headers = getattr(exc, "headers", None)
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail}, headers=headers)

    logger.exception("Unhandled exception while handling request: %s %s", request.method, request.url)
    return JSONResponse(status_code=500, content={"detail": "Internal Server Error"})


# ---------- Simple request logger (dev) ----------
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response


class SimpleLoggerMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        logger.info("Incoming request: %s %s", request.method, request.url)
        try:
            resp: Response = await call_next(request)
            logger.info("Response: %s %s -> %s", request.method, request.url, resp.status_code)
            return resp
        except Exception:
            logger.exception("Unhandled error in middleware for %s %s", request.method, request.url)
            raise


app.add_middleware(SimpleLoggerMiddleware)

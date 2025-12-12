// static/app.js
const API = ""; // same-origin

// helpers
function showMessage(text, type = "error") {
  const el = document.getElementById("message");
  el.textContent = text;
  el.className = type === "error" ? "error" : "success";
  el.classList.remove("hidden");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), 3500);
}

async function parseJSONSafe(res) {
  const txt = await res.text();
  try { return JSON.parse(txt || "{}"); } catch { return { _raw: txt }; }
}

function tokenHeader() {
  const token = localStorage.getItem("token");
  return token ? { "Authorization": `Bearer ${token}` } : {};
}

// auth
async function signup(username, password) {
  try {
    const res = await fetch(`${API}/auth/signup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    const data = await parseJSONSafe(res);
    if (!res.ok) {
      showMessage(data.detail || data._raw || "Signup failed", "error");
      return;
    }
    showMessage("Signup success — please login", "success");
  } catch (e) { showMessage("Network error: " + e.message, "error"); }
}

async function login(username, password) {
  try {
    const res = await fetch(`${API}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    const data = await parseJSONSafe(res);
    if (!res.ok) { showMessage(data.detail || data._raw || "Login failed", "error"); return; }
    localStorage.setItem("token", data.access_token);
    showApp();
    fetchPeople();
  } catch (e) { showMessage("Network error: " + e.message, "error"); }
}

function logout() {
  localStorage.removeItem("token");
  showAuth();
}

// CRUD
async function createPerson(form) {
  try {
    const body = {
      name: form.name.value.trim(),
      roll: form.roll.value.trim(),
      age: Number(form.age.value),
      gender: form.gender.value
    };
    const res = await fetch(`${API}/persons`, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, tokenHeader()),
      body: JSON.stringify(body)
    });
    const data = await parseJSONSafe(res);
    if (!res.ok) { showMessage(data.detail || data._raw || "Create failed", "error"); return; }
    showMessage("Person created", "success");
    form.reset();
    fetchPeople();
  } catch (e) { showMessage("Network error: " + e.message, "error"); }
}

async function fetchPeople(search = "") {
  try {
    const url = search ? `/persons?search=${encodeURIComponent(search)}` : "/persons";
    const res = await fetch(`${API}${url}`, {
      headers: tokenHeader()
    });
    if (res.status === 401) { showMessage("Session expired", "error"); logout(); return; }
    const data = await parseJSONSafe(res);
    if (!res.ok) { showMessage(data.detail || data._raw || "Error fetching", "error"); return; }
    renderPeople(data.items || []);
  } catch (e) { showMessage("Network error: " + e.message, "error"); }
}

function renderPeople(items) {
  const ul = document.getElementById("people-list");
  ul.innerHTML = "";
  items.forEach(p => {
    const li = document.createElement("li");
    li.className = "person";
    li.innerHTML = `
      <div class="meta">
        <strong>${p.name}</strong> <span class="small">[Roll: ${p.roll}]</span><br/>
        <span class="small">Age: ${p.age} • Gender: ${p.gender} • ID: ${p.id}</span>
      </div>
      <div class="actions">
        <button data-id="${p.id}" class="btn-edit">Edit</button>
        <button data-id="${p.id}" class="btn-delete">Delete</button>
      </div>
    `;
    ul.appendChild(li);
  });
  // wire edit/delete
  document.querySelectorAll(".btn-edit").forEach(b => b.addEventListener("click", onEdit));
  document.querySelectorAll(".btn-delete").forEach(b => b.addEventListener("click", onDelete));
}

async function onDelete(e) {
  const id = e.currentTarget.dataset.id;
  if (!confirm("Delete person id " + id + "?")) return;
  try {
    const res = await fetch(`${API}/persons/${id}`, {
      method: "DELETE", headers: tokenHeader()
    });
    const data = await parseJSONSafe(res);
    if (!res.ok) { showMessage(data.detail || data._raw || "Delete failed", "error"); return; }
    showMessage("Deleted", "success");
    fetchPeople();
  } catch (err) { showMessage("Network error: " + err.message, "error"); }
}

async function onEdit(e) {
  const id = e.currentTarget.dataset.id;
  try {
    const res = await fetch(`${API}/persons/${id}`, { headers: tokenHeader() });
    const data = await parseJSONSafe(res);
    if (!res.ok) { showMessage(data.detail || data._raw || "Fetch failed", "error"); return; }
    // populate edit form
    document.getElementById("edit-id").value = data.id;
    document.getElementById("edit-name").value = data.name;
    document.getElementById("edit-roll").value = data.roll;
    document.getElementById("edit-age").value = data.age;
    document.getElementById("edit-gender").value = data.gender;
    window.scrollTo(0, document.body.scrollHeight);
  } catch (err) { showMessage("Network error: " + err.message, "error"); }
}

async function putPerson() {
  const id = document.getElementById("edit-id").value;
  const payload = {
    name: document.getElementById("edit-name").value.trim(),
    roll: document.getElementById("edit-roll").value.trim(),
    age: Number(document.getElementById("edit-age").value),
    gender: document.getElementById("edit-gender").value
  };
  try {
    const res = await fetch(`${API}/persons/${id}`, {
      method: "PUT",
      headers: Object.assign({ "Content-Type": "application/json" }, tokenHeader()),
      body: JSON.stringify(payload)
    });
    const data = await parseJSONSafe(res);
    if (!res.ok) { showMessage(data.detail || data._raw || "PUT failed", "error"); return; }
    showMessage("Person replaced", "success");
    fetchPeople();
  } catch (err) { showMessage("Network error: " + err.message, "error"); }
}

async function patchPerson() {
  const id = document.getElementById("edit-id").value;
  const payload = {};
  const n = document.getElementById("edit-name").value.trim();
  const r = document.getElementById("edit-roll").value.trim();
  const a = document.getElementById("edit-age").value;
  const g = document.getElementById("edit-gender").value;
  if (n) payload.name = n;
  if (r) payload.roll = r;
  if (a) payload.age = Number(a);
  if (g) payload.gender = g;
  try {
    const res = await fetch(`${API}/persons/${id}`, {
      method: "PATCH",
      headers: Object.assign({ "Content-Type": "application/json" }, tokenHeader()),
      body: JSON.stringify(payload)
    });
    const data = await parseJSONSafe(res);
    if (!res.ok) { showMessage(data.detail || data._raw || "PATCH failed", "error"); return; }
    showMessage("Person updated (partial)", "success");
    fetchPeople();
  } catch (err) { showMessage("Network error: " + err.message, "error"); }
}

// UI wiring
function showApp() {
  document.getElementById("auth").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
}
function showAuth() {
  document.getElementById("app").classList.add("hidden");
  document.getElementById("auth").classList.remove("hidden");
}

// startup wiring
document.addEventListener("DOMContentLoaded", () => {
  // if logged in
  if (localStorage.getItem("token")) {
    showApp();
    fetchPeople();
  }

  // signup
  document.getElementById("signup-form").addEventListener("submit", e => {
    const u = document.getElementById("signup-username").value.trim();
    const p = document.getElementById("signup-password").value;
    signup(u, p);
  });

  // login
  document.getElementById("login-form").addEventListener("submit", e => {
    const u = document.getElementById("login-username").value.trim();
    const p = document.getElementById("login-password").value;
    login(u, p);
  });

  // logout
  document.getElementById("logout").addEventListener("click", logout);

  // create person
  document.getElementById("create-form").addEventListener("submit", e => {
    const form = {
      name: document.getElementById("p-name"),
      roll: document.getElementById("p-roll"),
      age: document.getElementById("p-age"),
      gender: document.getElementById("p-gender")
    };
    createPerson(form);
  });

  // search
  document.getElementById("btn-search").addEventListener("click", () => {
    const q = document.getElementById("search").value.trim();
    fetchPeople(q);
  });

  // put/patch
  document.getElementById("btn-put").addEventListener("click", putPerson);
  document.getElementById("btn-patch").addEventListener("click", patchPerson);
});

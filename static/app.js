// app.js
const API = ""; // same-origin (keep empty for same origin)

// helpers
function showMessage(text, type = "error") {
  const el = document.getElementById("message");
  el.textContent = text;
  // clear classes except hidden
  el.classList.remove("error", "success");
  el.classList.add(type === "error" ? "error" : "success");
  el.classList.remove("hidden");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), 3500);
}

async function parseJSONSafe(res) {
  const txt = await res.text();
  try {
    return JSON.parse(txt || "{}");
  } catch {
    return { _raw: txt };
  }
}

function tokenHeader() {
  const token = localStorage.getItem("token");
  return token ? { "Authorization": `Bearer ${token}` } : {};
}

function safeFetch(url, opts = {}) {
  // wrapper to always use same-origin API prefix
  return fetch(`${API}${url}`, opts);
}

// auth
async function signup(username, password, formEl) {
  try {
    const res = await safeFetch("/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await parseJSONSafe(res);
    if (!res.ok) {
      showMessage(data.detail || data._raw || "Signup failed", "error");
      return false;
    }
    showMessage("Signup success — please login", "success");
    // optional: reset signup form
    if (formEl && typeof formEl.reset === "function") formEl.reset();
    return true;
  } catch (e) {
    showMessage("Network error: " + e.message, "error");
    return false;
  }
}

async function login(username, password, formEl) {
  try {
    const res = await safeFetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await parseJSONSafe(res);
    if (!res.ok) {
      showMessage(data.detail || data._raw || "Login failed", "error");
      return false;
    }
    localStorage.setItem("token", data.access_token);
    if (formEl && typeof formEl.reset === "function") formEl.reset();
    showApp();
    await fetchPeople();
    return true;
  } catch (e) {
    showMessage("Network error: " + e.message, "error");
    return false;
  }
}

function logout() {
  localStorage.removeItem("token");
  showAuth();
}

// CRUD
async function createPerson(formEl) {
  // ensure we have the actual HTMLFormElement
  if (!formEl || typeof formEl.reset !== "function") {
    showMessage("Internal error: invalid form", "error");
    return;
  }

  try {
    const body = {
      name: formEl.name.value.trim(),
      roll: formEl.roll.value.trim(),
      age: Number(formEl.age.value),
      gender: formEl.gender.value,
    };
    const res = await safeFetch("/persons", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, tokenHeader()),
      body: JSON.stringify(body),
    });
    const data = await parseJSONSafe(res);
    if (!res.ok) {
      // if unauthorized, force logout
      if (res.status === 401) {
        showMessage("Session expired", "error");
        logout();
        return;
      }
      showMessage(data.detail || data._raw || "Create failed", "error");
      return;
    }
    showMessage("Person created", "success");
    formEl.reset(); // call reset on the real form element
    // scroll to people list and refresh
    document.getElementById("people-list").scrollIntoView({ behavior: "smooth" });
    await fetchPeople();
  } catch (e) {
    showMessage("Network error: " + e.message, "error");
  }
}

async function fetchPeople(search = "") {
  try {
    const url = search ? `/persons?search=${encodeURIComponent(search)}` : "/persons";
    const res = await safeFetch(url, {
      headers: tokenHeader(),
    });

    if (res.status === 401) {
      showMessage("Session expired", "error");
      logout();
      return;
    }

    const data = await parseJSONSafe(res);
    if (!res.ok) {
      showMessage(data.detail || data._raw || "Error fetching", "error");
      return;
    }
    renderPeople(data.items || []);
  } catch (e) {
    showMessage("Network error: " + e.message, "error");
  }
}

function renderPeople(items) {
  const ul = document.getElementById("people-list");
  ul.innerHTML = "";
  items.forEach((p) => {
    const li = document.createElement("li");
    li.className = "person";
    // use template but keep it safe-ish (we assume server data is trusted here)
    li.innerHTML = `
      <div class="meta">
        <strong>${escapeHtml(p.name)}</strong> <span class="small">[Roll: ${escapeHtml(p.roll)}]</span><br/>
        <span class="small">Age: ${escapeHtml(String(p.age))} • Gender: ${escapeHtml(p.gender)} • ID: ${escapeHtml(String(p.id))}</span>
      </div>
      <div class="actions">
        <button data-id="${p.id}" class="btn-edit">Edit</button>
        <button data-id="${p.id}" class="btn-delete">Delete</button>
      </div>
    `;
    ul.appendChild(li);
  });

  // wire edit/delete using event delegation for robustness
  ul.removeEventListener("click", delegatedClick);
  ul.addEventListener("click", delegatedClick);
}

function delegatedClick(ev) {
  const editBtn = ev.target.closest(".btn-edit");
  if (editBtn) {
    onEdit({ currentTarget: editBtn });
    return;
  }
  const delBtn = ev.target.closest(".btn-delete");
  if (delBtn) {
    onDelete({ currentTarget: delBtn });
    return;
  }
}

async function onDelete(e) {
  const btn = e.currentTarget;
  const id = String(btn.dataset.id || "").trim();
  if (!id) {
    showMessage("Invalid id for delete", "error");
    return;
  }
  if (!confirm("Delete person id " + id + " ?")) return;

  // disable button while request in-flight
  const prevDisabled = btn.disabled;
  btn.disabled = true;
  try {
    const res = await safeFetch(`/persons/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: tokenHeader(),
    });
    const data = await parseJSONSafe(res);
    if (!res.ok) {
      if (res.status === 401) {
        showMessage("Session expired", "error");
        logout();
        return;
      }
      showMessage(data.detail || data._raw || "Delete failed", "error");
      return;
    }
    showMessage("Deleted", "success");
    await fetchPeople();
  } catch (err) {
    showMessage("Network error: " + err.message, "error");
  } finally {
    btn.disabled = prevDisabled;
  }
}

async function onEdit(e) {
  const id = String(e.currentTarget.dataset.id || "").trim();
  if (!id) {
    showMessage("Invalid id for edit", "error");
    return;
  }
  try {
    const res = await safeFetch(`/persons/${encodeURIComponent(id)}`, {
      headers: tokenHeader(),
    });
    const data = await parseJSONSafe(res);
    if (!res.ok) {
      if (res.status === 401) {
        showMessage("Session expired", "error");
        logout();
        return;
      }
      showMessage(data.detail || data._raw || "Fetch failed", "error");
      return;
    }
    // populate edit form
    document.getElementById("edit-id").value = data.id;
    document.getElementById("edit-name").value = data.name || "";
    document.getElementById("edit-roll").value = data.roll || "";
    document.getElementById("edit-age").value = data.age != null ? data.age : "";
    document.getElementById("edit-gender").value = data.gender || "";
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  } catch (err) {
    showMessage("Network error: " + err.message, "error");
  }
}

async function putPerson() {
  const id = String(document.getElementById("edit-id").value || "").trim();
  if (!id) {
    showMessage("No person selected for PUT", "error");
    return;
  }
  const payload = {
    name: document.getElementById("edit-name").value.trim(),
    roll: document.getElementById("edit-roll").value.trim(),
    age: Number(document.getElementById("edit-age").value),
    gender: document.getElementById("edit-gender").value,
  };
  try {
    const res = await safeFetch(`/persons/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: Object.assign({ "Content-Type": "application/json" }, tokenHeader()),
      body: JSON.stringify(payload),
    });
    const data = await parseJSONSafe(res);
    if (!res.ok) {
      if (res.status === 401) {
        showMessage("Session expired", "error");
        logout();
        return;
      }
      showMessage(data.detail || data._raw || "PUT failed", "error");
      return;
    }
    showMessage("Person replaced", "success");
    await fetchPeople();
  } catch (err) {
    showMessage("Network error: " + err.message, "error");
  }
}

async function patchPerson() {
  const id = String(document.getElementById("edit-id").value || "").trim();
  if (!id) {
    showMessage("No person selected for PATCH", "error");
    return;
  }
  const payload = {};
  const n = document.getElementById("edit-name").value.trim();
  const r = document.getElementById("edit-roll").value.trim();
  const a = document.getElementById("edit-age").value;
  const g = document.getElementById("edit-gender").value;
  if (n) payload.name = n;
  if (r) payload.roll = r;
  if (a !== "") payload.age = Number(a);
  if (g) payload.gender = g;

  if (Object.keys(payload).length === 0) {
    showMessage("No fields provided for PATCH", "error");
    return;
  }

  try {
    const res = await safeFetch(`/persons/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: Object.assign({ "Content-Type": "application/json" }, tokenHeader()),
      body: JSON.stringify(payload),
    });
    const data = await parseJSONSafe(res);
    if (!res.ok) {
      if (res.status === 401) {
        showMessage("Session expired", "error");
        logout();
        return;
      }
      showMessage(data.detail || data._raw || "PATCH failed", "error");
      return;
    }
    showMessage("Person updated (partial)", "success");
    await fetchPeople();
  } catch (err) {
    showMessage("Network error: " + err.message, "error");
  }
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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// startup wiring
document.addEventListener("DOMContentLoaded", () => {
  // if logged in
  if (localStorage.getItem("token")) {
    showApp();
    fetchPeople();
  } else {
    showAuth();
  }

  // signup
  const signupForm = document.getElementById("signup-form");
  signupForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const u = document.getElementById("signup-username").value.trim();
    const p = document.getElementById("signup-password").value;
    signup(u, p, signupForm);
  });

  // login
  const loginForm = document.getElementById("login-form");
  loginForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const u = document.getElementById("login-username").value.trim();
    const p = document.getElementById("login-password").value;
    login(u, p, loginForm);
  });

  // logout
  document.getElementById("logout").addEventListener("click", logout);

  // create person - pass real form element
  const createForm = document.getElementById("create-form");
  createForm.addEventListener("submit", (e) => {
    e.preventDefault();
    createPerson(createForm);
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

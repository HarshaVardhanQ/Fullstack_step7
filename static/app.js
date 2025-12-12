// app.js
const API = ""; // same-origin (keep empty for same origin)

// helpers
function showMessage(text, type = "error") {
  const el = document.getElementById("message");
  if (!el) return;
  el.textContent = text;
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
    // server returns access_token
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
      if (res.status === 401) {
        showMessage("Session expired", "error");
        logout();
        return;
      }
      showMessage(data.detail || data._raw || "Create failed", "error");
      return;
    }
    showMessage("Person created", "success");
    formEl.reset();
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
  if (!ul) return;
  ul.innerHTML = "";

  items.forEach((p) => {
    // choose the id the API expects for per-user lookup: user_person_id if present else id
    const apiId = p.user_person_id != null ? p.user_person_id : p.id;
    const displayId = p.user_person_id != null ? `${p.user_person_id} (user)` : p.id;

    const li = document.createElement("li");
    li.className = "person";
    li.innerHTML = `
      <div class="meta">
        <strong>${escapeHtml(p.name)}</strong> <span class="small">[Roll: ${escapeHtml(p.roll)}]</span><br/>
        <span class="small">Age: ${escapeHtml(String(p.age))} • Gender: ${escapeHtml(p.gender)} • ID: ${escapeHtml(String(displayId))}</span>
      </div>
      <div class="actions">
        <button data-api-id="${apiId}" class="btn-edit">Edit</button>
        <button data-api-id="${apiId}" class="btn-delete">Delete</button>
      </div>
    `;
    ul.appendChild(li);
  });

  // wire edit/delete using event delegation for robustness
  // attach once (idempotent)
  if (!ul._delegationAttached) {
    ul.addEventListener("click", delegatedClick);
    ul._delegationAttached = true;
  }
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
  const id = String(btn.dataset.apiId || "").trim();
  if (!id) {
    showMessage("Invalid id for delete", "error");
    return;
  }
  if (!confirm("Delete person id " + id + " ?")) return;

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
  const btn = e.currentTarget;
  const id = String(btn.dataset.apiId || "").trim();
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
    // populate edit form (use form fields with ids: edit-id, edit-name, edit-roll, edit-age, edit-gender)
    document.getElementById("edit-id").value = id; // IMPORTANT: store the API-lookup id here
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
  const authEl = document.getElementById("auth");
  const appEl = document.getElementById("app");
  if (authEl) authEl.classList.add("hidden");
  if (appEl) appEl.classList.remove("hidden");
}
function showAuth() {
  const authEl = document.getElementById("auth");
  const appEl = document.getElementById("app");
  if (appEl) appEl.classList.add("hidden");
  if (authEl) authEl.classList.remove("hidden");
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
  if (localStorage.getItem("token")) {
    showApp();
    fetchPeople();
  } else {
    showAuth();
  }

  // signup
  const signupForm = document.getElementById("signup-form");
  if (signupForm) {
    signupForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const u = document.getElementById("signup-username").value.trim();
      const p = document.getElementById("signup-password").value;
      signup(u, p, signupForm);
    });
  }

  // login
  const loginForm = document.getElementById("login-form");
  if (loginForm) {
    loginForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const u = document.getElementById("login-username").value.trim();
      const p = document.getElementById("login-password").value;
      login(u, p, loginForm);
    });
  }

  // logout
  const logoutBtn = document.getElementById("logout");
  if (logoutBtn) logoutBtn.addEventListener("click", logout);

  // create person - pass real form element
  const createForm = document.getElementById("create-form");
  if (createForm) {
    createForm.addEventListener("submit", (e) => {
      e.preventDefault();
      createPerson(createForm);
    });
  }

  // search
  const btnSearch = document.getElementById("btn-search");
  if (btnSearch) {
    btnSearch.addEventListener("click", () => {
      const q = document.getElementById("search").value.trim();
      fetchPeople(q);
    });
  }

  // put/patch buttons
  const btnPut = document.getElementById("btn-put");
  if (btnPut) btnPut.addEventListener("click", putPerson);
  const btnPatch = document.getElementById("btn-patch");
  if (btnPatch) btnPatch.addEventListener("click", patchPerson);
});

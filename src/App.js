import React, { useState, useEffect, useCallback } from 'react';
import { collection, doc, setDoc, getDocs, updateDoc, onSnapshot, writeBatch, deleteDoc } from 'firebase/firestore';
import { db } from './firebase';
import { INITIAL_CONTACTS, STAGES } from './data';
import './App.css';

const STAGE_CLASS = ['s0','s1','s2','s3','s4','s5','s6'];

const EMPTY_CONTACT_FORM = {
  name: '', email: '', company: '', role: '', direct: false,
  status: 0, notes: '', followup: { date: '', text: '' },
};

function sanitizeId(str) {
  return str.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function initials(name) {
  const p = (name || '').trim().split(' ');
  return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase();
}

function followupSortValue(dateStr) {
  if (!dateStr) return Number.MAX_SAFE_INTEGER;
  const ts = Date.parse(dateStr);
  return Number.isNaN(ts) ? Number.MAX_SAFE_INTEGER : ts;
}

function followupUrgency(dateStr, done) {
  if (done || !dateStr || dateStr === 'Sin fecha') return null;
  const ts = Date.parse(dateStr);
  if (Number.isNaN(ts)) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  if (d.getTime() < today.getTime()) return 'overdue';
  if (d.getTime() === today.getTime()) return 'today';
  return null;
}

function contactCompletenessScore(contact) {
  const followupsCount = Array.isArray(contact.followups) ? contact.followups.length : 0;
  return (
    ((contact.name || '').trim() ? 1 : 0) +
    ((contact.role || '').trim() ? 1 : 0) +
    ((contact.notes || '').trim() ? 2 : 0) +
    (contact.direct ? 1 : 0) +
    (Number.isInteger(contact.status) ? contact.status : 0) +
    followupsCount * 2
  );
}

export default function App() {
  const [contacts, setContacts] = useState([]);
  const [companies, setCompanies] = useState({});
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('contacts');
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterDirect, setFilterDirect] = useState('');
  const [page, setPage] = useState(1);
  const [panel, setPanel] = useState(null); // {type:'contact'|'company', id}
  const [saving, setSaving] = useState(false);
  const [showNewContact, setShowNewContact] = useState(false);
  const [highlightId, setHighlightId] = useState(null);
  const PER_PAGE = 20;

  // Load data from Firestore
  useEffect(() => {
    let unsub1, unsub2;
    const init = async () => {
      // Remove duplicate contacts by normalized email, keeping the richest record.
      const snap = await getDocs(collection(db, 'contacts'));
      const seenByEmail = new Map();
      const duplicateDocIds = [];
      snap.docs.forEach((d) => {
        const data = d.data();
        const normalizedEmail = (data.email || '').trim().toLowerCase();
        if (!normalizedEmail) return;
        const current = { id: d.id, ...data };
        if (!seenByEmail.has(normalizedEmail)) {
          seenByEmail.set(normalizedEmail, current);
          return;
        }
        const previous = seenByEmail.get(normalizedEmail);
        const keepCurrent = contactCompletenessScore(current) > contactCompletenessScore(previous);
        if (keepCurrent) {
          duplicateDocIds.push(previous.id);
          seenByEmail.set(normalizedEmail, current);
        } else {
          duplicateDocIds.push(current.id);
        }
      });

      if (duplicateDocIds.length > 0) {
        for (let i = 0; i < duplicateDocIds.length; i += 400) {
          const batch = writeBatch(db);
          duplicateDocIds.slice(i, i + 400).forEach((id) => batch.delete(doc(db, 'contacts', id)));
          await batch.commit();
        }
      }

      // Seed only missing contacts (batch write, not sequential)
      const freshSnap = await getDocs(collection(db, 'contacts'));
      const existingIds = new Set(freshSnap.docs.map(d => d.id));
      const existingEmails = new Set(
        freshSnap.docs
          .map((d) => (d.data().email || '').trim().toLowerCase())
          .filter(Boolean)
      );
      const missing = INITIAL_CONTACTS.filter((c) => {
        const normalizedEmail = (c.email || '').trim().toLowerCase();
        const idMissing = !existingIds.has(c.id);
        const emailMissing = !normalizedEmail || !existingEmails.has(normalizedEmail);
        return idMissing && emailMissing;
      });

      if (missing.length > 0) {
        setSaving(true);
        // Batch write in chunks of 400 (Firestore limit is 500)
        for (let i = 0; i < missing.length; i += 400) {
          const batch = writeBatch(db);
          missing.slice(i, i + 400).forEach(c => batch.set(doc(db, 'contacts', c.id), c));
          await batch.commit();
        }
        // Seed missing companies
        const compSnap = await getDocs(collection(db, 'companies'));
        const existingComps = new Set(compSnap.docs.map(d => d.id));
        const companyNames = [...new Set(INITIAL_CONTACTS.map(c => c.company))];
        const missingComps = companyNames.filter(n => !existingComps.has(n.replace(/[^a-zA-Z0-9]/g, '_')));
        if (missingComps.length > 0) {
          const compBatch = writeBatch(db);
          missingComps.forEach(name => {
            compBatch.set(doc(db, 'companies', name.replace(/[^a-zA-Z0-9]/g, '_')), { name, sector: '', size: '', website: '', pain: '', fit: '', notes: '' });
          });
          await compBatch.commit();
        }
        setSaving(false);
      }

      // Live listeners
      unsub1 = onSnapshot(collection(db, 'contacts'), (s) => {
        setContacts(s.docs.map(d => ({ ...d.data() })));
        setLoading(false);
      });
      unsub2 = onSnapshot(collection(db, 'companies'), (s) => {
        const obj = {};
        s.docs.forEach(d => { obj[d.data().name] = { ...d.data(), _id: d.id }; });
        setCompanies(obj);
      });
    };
    init();
    return () => { unsub1?.(); unsub2?.(); };
  }, []);

  const updateContact = useCallback(async (id, data) => {
    await updateDoc(doc(db, 'contacts', id), data);
  }, []);

  const updateCompany = useCallback(async (name, data) => {
    const comp = Object.values(companies).find(c => c.name === name);
    if (!comp) return;
    await updateDoc(doc(db, 'companies', comp._id), data);
  }, [companies]);

  const deleteContact = useCallback(async (id) => {
    await deleteDoc(doc(db, 'contacts', id));
  }, []);

  const filtered = contacts.filter(c => {
    const q = search.toLowerCase();
    const matchQ = !q || c.name.toLowerCase().includes(q) || c.company.toLowerCase().includes(q) || c.email.toLowerCase().includes(q);
    const matchS = filterStatus === '' || c.status === parseInt(filterStatus);
    const matchD = filterDirect === '' || (filterDirect === '1' ? c.direct : !c.direct);
    return matchQ && matchS && matchD;
  });

  const totalPages = Math.ceil(filtered.length / PER_PAGE);
  const pageData = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  useEffect(() => {
    if (!highlightId) return;
    const c = contacts.find(x => x.id === highlightId);
    if (!c) return;
    const idx = filtered.findIndex(x => x.id === highlightId);
    if (idx >= 0) {
      const pageNum = Math.floor(idx / PER_PAGE) + 1;
      setPage(p => (p !== pageNum ? pageNum : p));
    }
    const timer = setTimeout(() => {
      const el = document.querySelector(`[data-contact-id="${highlightId}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 150);
    const clear = setTimeout(() => setHighlightId(null), 3000);
    return () => { clearTimeout(timer); clearTimeout(clear); };
  }, [highlightId, contacts, filtered]);

  const handleNewContactSuccess = (id) => {
    setActiveTab('contacts');
    setSearch('');
    setFilterStatus('');
    setFilterDirect('');
    setHighlightId(id);
  };

  const stats = {
    total: contacts.length,
    direct: contacts.filter(c => c.direct).length,
    sent: contacts.filter(c => c.status >= 1).length,
    replied: contacts.filter(c => c.status >= 2).length,
    followups: contacts.filter(c => c.followups?.some(f => !f.done)).length,
  };

  const exportCSV = () => {
    const rows = [['Nombre','Email','Empresa','Estado','Directo','Rol','Notas']];
    contacts.forEach(c => rows.push([c.name, c.email, c.company, STAGES[c.status], c.direct ? 'Sí' : 'No', c.role || '', (c.notes || '').replace(/\n/g, ' ')]));
    const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    a.download = 'interantio_crm.csv';
    a.click();
  };

  if (loading) return (
    <div className="loading">
      <div className="loading-inner">
        <div className="spinner"></div>
        <p>{saving ? 'Inicializando base de datos...' : 'Cargando CRM...'}</p>
      </div>
    </div>
  );

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">interantio <span>CRM</span></div>
        <div className="tabs">
          <button type="button" className="btn-new-contact" onClick={() => setShowNewContact(true)}>
            + Nuevo contacto
          </button>
          {['contacts','companies','pipeline','followups'].map((t, i) => (
            <button key={t} className={`tab${activeTab === t ? ' active' : ''}`} onClick={() => setActiveTab(t)}>
              {['Contactos','Empresas','Pipeline','Follow ups'][i]}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'contacts' && (
        <div>
          <div className="stats-grid">
            <div className="stat"><div className="stat-label">Total</div><div className="stat-val">{stats.total}</div></div>
            <div className="stat"><div className="stat-label">Contacto directo</div><div className="stat-val">{stats.direct}</div></div>
            <div className="stat"><div className="stat-label">Emails enviados</div><div className="stat-val">{stats.sent}</div></div>
            <div className="stat"><div className="stat-label">Respondieron</div><div className="stat-val">{stats.replied}</div></div>
            <div className="stat"><div className="stat-label">Follow-ups pend.</div><div className="stat-val">{stats.followups}</div></div>
          </div>
          <div className="filters">
            <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Buscar nombre, empresa, email..." className="search-input" />
            <select value={filterStatus} onChange={e => { setFilterStatus(e.target.value); setPage(1); }}>
              <option value="">Todos los estados</option>
              {STAGES.map((s,i) => <option key={i} value={i}>{s}</option>)}
            </select>
            <select value={filterDirect} onChange={e => { setFilterDirect(e.target.value); setPage(1); }}>
              <option value="">Todos</option>
              <option value="1">Contacto directo</option>
              <option value="0">Sin contacto directo</option>
            </select>
            <button className="btn" onClick={exportCSV}>↓ Exportar CSV</button>
          </div>
          <div className="table-wrap">
            <table className="contact-table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Empresa</th>
                  <th>Estado</th>
                  <th>Próx. follow-up</th>
                  <th>Directo</th>
                </tr>
              </thead>
              <tbody>
                {pageData.length === 0 ? (
                  <tr><td colSpan={5} className="empty">No se encontraron contactos</td></tr>
                ) : pageData.map(c => {
                  const pending = (c.followups || []).filter(f => !f.done).sort((a,b) => a.date > b.date ? 1 : -1);
                  const next = pending[0];
                  return (
                    <tr
                      key={c.id}
                      data-contact-id={c.id}
                      className={highlightId === c.id ? 'row-highlight' : ''}
                      onClick={() => setPanel({ type: 'contact', id: c.id })}
                    >
                      <td>
                        <div className="contact-cell">
                          <div className="initials-circle">{initials(c.name)}</div>
                          <div>
                            <div className="contact-name">{c.name}</div>
                            <div className="contact-email">{c.email}</div>
                          </div>
                        </div>
                      </td>
                      <td>{c.company}</td>
                      <td><span className={`badge ${STAGE_CLASS[c.status]}`}>{STAGES[c.status]}</span></td>
                      <td>{next ? <span className="next-fu">{next.date} · {next.text?.substring(0,30)}</span> : <span className="empty-dash">—</span>}</td>
                      <td>{c.direct && <span className="badge direct">✓ Directo</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="paginator">
              <span>{filtered.length} contactos · pág {page}/{totalPages}</span>
              <button className="btn" onClick={() => setPage(p => Math.max(1, p-1))} disabled={page === 1}>‹</button>
              <button className="btn" onClick={() => setPage(p => Math.min(totalPages, p+1))} disabled={page === totalPages}>›</button>
            </div>
          )}
        </div>
      )}

      {activeTab === 'companies' && (
        <CompaniesTab contacts={contacts} companies={companies} setPanel={setPanel} />
      )}

      {activeTab === 'pipeline' && (
        <PipelineTab contacts={contacts} setPanel={setPanel} />
      )}

      {activeTab === 'followups' && (
        <FollowupsTab contacts={contacts} setPanel={setPanel} />
      )}

      {panel && (
        <PanelOverlay
          panel={panel}
          contacts={contacts}
          companies={companies}
          onClose={() => setPanel(null)}
          updateContact={updateContact}
          updateCompany={updateCompany}
          deleteContact={deleteContact}
          setPanel={setPanel}
        />
      )}

      {showNewContact && (
        <NewContactModal
          contacts={contacts}
          companies={companies}
          onClose={() => setShowNewContact(false)}
          onSuccess={handleNewContactSuccess}
        />
      )}
    </div>
  );
}

function CompaniesTab({ contacts, companies, setPanel }) {
  const [q, setQ] = useState('');
  const companyNames = Object.keys(companies).filter(n => !q || n.toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <div className="filters">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar empresa..." className="search-input" />
      </div>
      <div className="company-grid">
        {companyNames.map(name => {
          const cc = contacts.filter(c => c.company === name);
          const sent = cc.filter(c => c.status >= 1).length;
          const replied = cc.filter(c => c.status >= 2).length;
          const pct = cc.length ? Math.round((sent / cc.length) * 100) : 0;
          const comp = companies[name] || {};
          return (
            <div key={name} className="company-card" onClick={() => setPanel({ type: 'company', name })}>
              <div className="company-name">{name}</div>
              <div className="company-meta">{cc.length} contactos · {sent} enviados · {replied} respuestas</div>
              {comp.sector && <div className="company-sector">{comp.sector}</div>}
              <div className="progress-bar"><div className="progress-fill" style={{ width: pct + '%' }}></div></div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PipelineTab({ contacts, setPanel }) {
  return (
    <div className="pipeline-col">
      {STAGES.map((stage, i) => {
        const cc = contacts.filter(c => c.status === i);
        return (
          <div key={i} className="pipeline-row">
            <div className="pipeline-row-header">
              <span className={`badge ${STAGE_CLASS[i]}`}>{stage}</span>
              <span className="pipeline-count">{cc.length} contactos</span>
            </div>
            {cc.length > 0 && (
              <div className="pipeline-chips">
                {cc.slice(0, 15).map(c => (
                  <div key={c.id} className={`pipeline-chip${c.direct ? ' chip-direct' : ''}`} onClick={() => setPanel({ type: 'contact', id: c.id })}>
                    {c.direct && <span className="direct-dot"></span>}
                    {c.name}
                  </div>
                ))}
                {cc.length > 15 && <span className="chip-more">+{cc.length - 15} más</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FollowupsTab({ contacts, setPanel }) {
  const [showCompleted, setShowCompleted] = useState(false);

  const followups = contacts
    .flatMap(contact =>
      (contact.followups || []).map((followup, index) => ({
        id: `${contact.id}-${index}`,
        contactId: contact.id,
        contactName: contact.name,
        company: contact.company,
        date: followup.date || 'Sin fecha',
        text: followup.text || '',
        done: !!followup.done,
        urgency: followupUrgency(followup.date, !!followup.done),
      }))
    )
    .filter(f => showCompleted || !f.done)
    .sort((a, b) => {
      const byDate = followupSortValue(a.date) - followupSortValue(b.date);
      if (byDate !== 0) return byDate;
      if (a.done !== b.done) return a.done ? 1 : -1;
      return a.contactName.localeCompare(b.contactName);
    });

  return (
    <>
      <div className="filters followups-filters">
        <label className="followups-show-done">
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={e => setShowCompleted(e.target.checked)}
          />
          Mostrar realizados
        </label>
      </div>
      <div className="table-wrap">
        <table className="contact-table followups-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Contacto</th>
              <th>Empresa</th>
              <th>Follow-up</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {followups.length === 0 ? (
              <tr><td colSpan={5} className="empty">No hay follow-ups registrados</td></tr>
            ) : followups.map(f => (
              <tr
                key={f.id}
                className={[
                  f.done ? 'fu-row-done' : '',
                  f.urgency === 'overdue' ? 'fu-row-overdue' : '',
                  f.urgency === 'today' ? 'fu-row-today' : '',
                ].filter(Boolean).join(' ')}
                onClick={() => setPanel({ type: 'contact', id: f.contactId })}
              >
                <td className={f.done ? 'fu-strike' : ''}>{f.date}</td>
                <td className={f.done ? 'fu-strike' : ''}>{f.contactName}</td>
                <td className={f.done ? 'fu-strike' : ''}>{f.company}</td>
                <td className={f.done ? 'fu-strike' : ''}>{f.text || <span className="empty-dash">—</span>}</td>
                <td>
                  {f.urgency === 'overdue' && (
                    <span className="badge fu-badge-overdue">overdue</span>
                  )}
                  {f.urgency === 'today' && (
                    <span className="badge fu-badge-today">today</span>
                  )}
                  <span className={`badge ${f.done ? 's6' : 's3'}`}>
                    {f.done ? 'Hecho' : 'Pendiente'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function NewContactModal({ contacts, companies, onClose, onSuccess }) {
  const [form, setForm] = useState({ ...EMPTY_CONTACT_FORM });
  const [formSaving, setFormSaving] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [formError, setFormError] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);

  const companyNames = Object.keys(companies);
  const suggestions = form.company.trim()
    ? companyNames.filter(n => n.toLowerCase().includes(form.company.toLowerCase())).slice(0, 8)
    : [];

  const resetAndClose = () => {
    setForm({ ...EMPTY_CONTACT_FORM });
    setEmailError('');
    setFormError('');
    setShowSuggestions(false);
    onClose();
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setEmailError('');
    setFormError('');

    if (!form.name.trim()) {
      setFormError('El nombre es obligatorio');
      return;
    }
    if (!form.email.trim()) {
      setFormError('El email es obligatorio');
      return;
    }
    if (!isValidEmail(form.email.trim())) {
      setFormError('Introduce un email válido');
      return;
    }

    const emailLower = form.email.trim().toLowerCase();
    if (contacts.some(c => c.email?.toLowerCase() === emailLower)) {
      setEmailError('Ya existe un contacto con este email');
      return;
    }

    const id = sanitizeId(form.email);
    const companyName = form.company.trim();
    const companyId = sanitizeId(companyName);

    setFormSaving(true);
    try {
      await setDoc(doc(db, 'contacts', id), {
        id,
        name: form.name.trim(),
        email: emailLower,
        company: companyName,
        direct: form.direct,
        status: Number(form.status) || 0,
        notes: form.notes.trim(),
        followups: form.followup.text
          ? [{ date: form.followup.date || 'Sin fecha', text: form.followup.text.trim(), done: false }]
          : [],
        role: form.role.trim(),
        lastContact: null,
      });

      if (companyName && !companies[companyName]) {
        await setDoc(doc(db, 'companies', companyId), {
          name: companyName,
          sector: '', size: '', website: '', pain: '', fit: '', notes: '',
        });
      }

      setForm({ ...EMPTY_CONTACT_FORM });
      onSuccess(id);
      onClose();
    } catch {
      setFormError('Error al guardar. Intenta de nuevo.');
    } finally {
      setFormSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={resetAndClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Nuevo contacto</h2>
          <button type="button" className="close-btn" onClick={resetAndClose}>✕</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-section">
            <div className="form-section-title">Contacto</div>
            <div className="form-group">
              <label className="form-label">Nombre *</label>
              <input
                type="text"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Nombre completo"
              />
            </div>
            <div className="form-group">
              <label className="form-label">Email *</label>
              <input
                type="email"
                value={form.email}
                onChange={e => { setForm(f => ({ ...f, email: e.target.value })); setEmailError(''); }}
                placeholder="email@empresa.com"
              />
              {emailError && <div className="form-error">{emailError}</div>}
            </div>
            <div className="form-group form-group-autocomplete">
              <label className="form-label">Empresa</label>
              <input
                type="text"
                value={form.company}
                onChange={e => setForm(f => ({ ...f, company: e.target.value }))}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                placeholder="Nombre de la empresa"
                autoComplete="off"
              />
              {showSuggestions && suggestions.length > 0 && (
                <div className="autocomplete-list">
                  {suggestions.map(name => (
                    <div
                      key={name}
                      className="autocomplete-item"
                      onMouseDown={() => {
                        setForm(f => ({ ...f, company: name }));
                        setShowSuggestions(false);
                      }}
                    >
                      {name}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="form-group">
              <label className="form-label">Rol</label>
              <input
                type="text"
                value={form.role}
                onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                placeholder="Ej: Innovation Manager"
              />
            </div>
            <div className="toggle-row">
              <span className="form-label" style={{ margin: 0 }}>Contacto directo</span>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={form.direct}
                  onChange={e => setForm(f => ({ ...f, direct: e.target.checked }))}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-title">Estado inicial</div>
            <div className="form-group">
              <label className="form-label">Estado del pipeline</label>
              <select
                value={form.status}
                onChange={e => setForm(f => ({ ...f, status: parseInt(e.target.value, 10) }))}
              >
                {STAGES.map((s, i) => <option key={i} value={i}>{s}</option>)}
              </select>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Fecha follow-up</label>
                <input
                  type="date"
                  value={form.followup.date}
                  onChange={e => setForm(f => ({ ...f, followup: { ...f.followup, date: e.target.value } }))}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Texto follow-up</label>
                <input
                  type="text"
                  value={form.followup.text}
                  onChange={e => setForm(f => ({ ...f, followup: { ...f.followup, text: e.target.value } }))}
                  placeholder="Descripción..."
                />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Notas iniciales</label>
              <textarea
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Contexto, notas..."
                rows={3}
              />
            </div>
          </div>

          {formError && <div className="form-error" style={{ marginBottom: 12 }}>{formError}</div>}

          <button type="submit" className="btn-save" disabled={formSaving}>
            {formSaving ? 'Guardando...' : 'Guardar contacto'}
          </button>
        </form>
      </div>
    </div>
  );
}

function PanelOverlay({ panel, contacts, companies, onClose, updateContact, updateCompany, deleteContact, setPanel }) {
  const [fuDate, setFuDate] = useState('');
  const [fuText, setFuText] = useState('');
  const [localData, setLocalData] = useState({});
  const [localComp, setLocalComp] = useState({});
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletingLead, setDeletingLead] = useState(false);

  const contact = panel.type === 'contact' ? contacts.find(c => c.id === panel.id) : null;
  const compName = panel.type === 'company' ? panel.name : contact?.company;
  const comp = companies[compName] || {};

  useEffect(() => {
    if (contact) setLocalData({ role: contact.role || '', notes: contact.notes || '' });
    setLocalComp({ sector: comp.sector || '', size: comp.size || '', website: comp.website || '', pain: comp.pain || '', fit: comp.fit || '', notes: comp.notes || '' });
  }, [panel.id, panel.name]);

  const saveContact = (field, val) => {
    updateContact(contact.id, { [field]: val });
  };
  const saveCompany = (field, val) => {
    updateCompany(compName, { [field]: val });
  };
  const setStatus = (s) => {
    updateContact(contact.id, { status: s, lastContact: new Date().toISOString().split('T')[0] });
  };
  const addFu = () => {
    if (!fuText) return;
    const fus = [...(contact.followups || []), { date: fuDate || 'Sin fecha', text: fuText, done: false }];
    updateContact(contact.id, { followups: fus });
    setFuDate(''); setFuText('');
  };
  const toggleFu = (i) => {
    const fus = contact.followups.map((f, idx) => idx === i ? { ...f, done: !f.done } : f);
    updateContact(contact.id, { followups: fus });
  };
  const deleteFu = (i) => {
    const fus = contact.followups.filter((_, idx) => idx !== i);
    updateContact(contact.id, { followups: fus });
  };

  const compContacts = contacts.filter(c => c.company === compName);
  const handleDeleteLead = async () => {
    if (!contact) return;
    setDeletingLead(true);
    try {
      await deleteContact(contact.id);
      onClose();
    } finally {
      setDeletingLead(false);
      setShowDeleteConfirm(false);
    }
  };

  return (
    <>
      <div className="overlay" onClick={onClose}></div>
      <div className="panel">
        <div className="panel-header">
          <div>
            <div className="panel-name">{panel.type === 'contact' ? contact?.name : compName}</div>
            <div className="panel-sub">{panel.type === 'contact' ? `${contact?.company}${localData.role ? ' · ' + localData.role : ''}` : `${compContacts.length} contactos`}</div>
            {panel.type === 'contact' && <a href={`mailto:${contact?.email}`} className="panel-email">{contact?.email}</a>}
            {panel.type === 'contact' && contact?.direct && <span className="badge direct" style={{display:'inline-block',marginTop:4}}>✓ Contacto directo</span>}
          </div>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        {panel.type === 'contact' && contact && (
          <>
            <div className="panel-section">
              <div className="panel-label">Rol del contacto</div>
              <input className="panel-input" value={localData.role} onChange={e => setLocalData(p => ({...p, role: e.target.value}))} onBlur={e => saveContact('role', e.target.value)} placeholder="Ej: Innovation Manager" />
            </div>
            <div className="panel-section">
              <div className="panel-label">Estado del pipeline</div>
              <div className="stage-pills">
                {STAGES.map((s, i) => (
                  <button key={i} className={`stage-pill ${STAGE_CLASS[i]}${contact.status === i ? ' active' : ''}`} onClick={() => setStatus(i)}>{s}</button>
                ))}
              </div>
            </div>
            <div className="panel-section">
              <div className="panel-label">Notas del contacto</div>
              <textarea className="panel-textarea" value={localData.notes} onChange={e => setLocalData(p => ({...p, notes: e.target.value}))} onBlur={e => saveContact('notes', e.target.value)} placeholder="Contexto de la conversación, datos personales relevantes..." />
            </div>
            <div className="panel-section">
              <div className="panel-label">Follow-ups</div>
              {(contact.followups || []).length === 0 && <p className="empty-msg">Sin follow-ups agendados</p>}
              {(contact.followups || []).map((f, i) => (
                <div key={i} className={`fu-item${f.done ? ' fu-done' : ''}`}>
                  <div>
                    <div className="fu-text">{f.text}</div>
                    <div className="fu-date">{f.date}</div>
                  </div>
                  <div className="fu-actions">
                    <button className="btn-sm" onClick={() => toggleFu(i)}>{f.done ? '↩' : '✓'}</button>
                    <button className="btn-sm" onClick={() => deleteFu(i)}>✕</button>
                  </div>
                </div>
              ))}
              <div className="add-fu">
                <input type="date" value={fuDate} onChange={e => setFuDate(e.target.value)} className="fu-date-input" />
                <input value={fuText} onChange={e => setFuText(e.target.value)} placeholder="Descripción..." className="fu-text-input" onKeyDown={e => e.key === 'Enter' && addFu()} />
                <button className="btn" onClick={addFu}>+</button>
              </div>
            </div>
            <div className="panel-divider"></div>
            <div className="panel-section">
              <button
                className="btn btn-danger"
                onClick={() => setShowDeleteConfirm(true)}
                type="button"
              >
                Eliminar lead
              </button>
            </div>
            <div className="panel-divider"></div>
            <div className="panel-label" style={{marginBottom:8}}>Ficha empresa — {compName}</div>
          </>
        )}

        {panel.type === 'company' && (
          <div className="panel-section">
            <div className="panel-label">Contactos</div>
            {compContacts.map(c => (
              <div key={c.id} className="comp-contact" onClick={() => setPanel({ type: 'contact', id: c.id })}>
                <div className="contact-cell">
                  <div className="initials-circle sm">{initials(c.name)}</div>
                  <div>
                    <div className="contact-name">{c.name}</div>
                    <div className="contact-email">{c.role || c.email}</div>
                  </div>
                </div>
                <span className={`badge ${STAGE_CLASS[c.status]}`}>{STAGES[c.status]}</span>
              </div>
            ))}
          </div>
        )}

        <div className="panel-section">
          <div className="panel-label">Datos empresa</div>
          <input className="panel-input" value={localComp.sector} onChange={e => setLocalComp(p=>({...p,sector:e.target.value}))} onBlur={e => saveCompany('sector', e.target.value)} placeholder="Sector / industria" />
          <input className="panel-input" value={localComp.size} onChange={e => setLocalComp(p=>({...p,size:e.target.value}))} onBlur={e => saveCompany('size', e.target.value)} placeholder="Tamaño de empresa" />
          <input className="panel-input" value={localComp.website} onChange={e => setLocalComp(p=>({...p,website:e.target.value}))} onBlur={e => saveCompany('website', e.target.value)} placeholder="Website" />
          <textarea className="panel-textarea" value={localComp.pain} onChange={e => setLocalComp(p=>({...p,pain:e.target.value}))} onBlur={e => saveCompany('pain', e.target.value)} placeholder="Pain points / oportunidades de AI para esta empresa..." style={{minHeight:60}} />
          <textarea className="panel-textarea" value={localComp.fit} onChange={e => setLocalComp(p=>({...p,fit:e.target.value}))} onBlur={e => saveCompany('fit', e.target.value)} placeholder="Ángulo de pitch Interantio — por qué fit con ellos..." style={{minHeight:60}} />
          <textarea className="panel-textarea" value={localComp.notes} onChange={e => setLocalComp(p=>({...p,notes:e.target.value}))} onBlur={e => saveCompany('notes', e.target.value)} placeholder="Notas generales sobre la empresa..." style={{minHeight:50}} />
        </div>
      </div>
      {showDeleteConfirm && (
        <div className="modal-overlay" onClick={() => !deletingLead && setShowDeleteConfirm(false)}>
          <div className="modal modal-confirm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Confirmar eliminación</h2>
              <button type="button" className="close-btn" onClick={() => !deletingLead && setShowDeleteConfirm(false)}>✕</button>
            </div>
            <p className="confirm-text">
              Vas a eliminar el lead <strong>{contact?.name}</strong>. Esta acción no se puede deshacer.
            </p>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setShowDeleteConfirm(false)} disabled={deletingLead} type="button">
                Cancelar
              </button>
              <button className="btn btn-danger" onClick={handleDeleteLead} disabled={deletingLead} type="button">
                {deletingLead ? 'Eliminando...' : 'Sí, eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

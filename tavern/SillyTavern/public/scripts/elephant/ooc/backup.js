const FORMAT = 'elephant-ooc-changes';

export function recordChanges(ledger, edits, reverse = false) {
    const changes = new Map(ledger.map(edit => [edit.id, edit]));
    for (const edit of edits) {
        const previous = changes.get(edit.id);
        const old = previous?.old ?? edit.old;
        const value = reverse ? edit.old : edit.value;
        if (old === value) changes.delete(edit.id);
        else changes.set(edit.id, { id: edit.id, label: edit.label, old, value });
    }
    return [...changes.values()];
}

export function writeBackup(changes) {
    return JSON.stringify({ format: FORMAT, version: 1, changes }, null, 2);
}

export function readBackup(raw) {
    const file = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (file?.format !== FORMAT || file.version !== 1 || !Array.isArray(file.changes)) throw new Error('bad-backup');
    const seen = new Set();
    for (const edit of file.changes) {
        if (!edit || ['id', 'label', 'old', 'value'].some(key => typeof edit[key] !== 'string') || !edit.id || seen.has(edit.id)) {
            throw new Error('bad-edit');
        }
        seen.add(edit.id);
    }
    return file.changes;
}

export function prepareRestore(edit, current, schema, varsOf) {
    const { old, value } = edit;
    if (current === value || old === value) return { status: 'same' };

    // Reapply append-only changes on updated templates without replacing their new instructions.
    const prefix = old ? old + '\n\n' : '';
    const append = value.startsWith(prefix) && value.length > prefix.length ? value.slice(prefix.length) : null;
    let next = value;
    let conflict = current !== old;
    const compatible = current => !varsOf(current).some(variable => !varsOf(next).includes(variable));
    if (current !== old && append !== null) {
        if (current.split('\n\n').includes(append) || current.endsWith('\n\n' + append)) return { status: 'same' };
        next = current ? current + '\n\n' + append : append;
        conflict = false;
    }
    if (schema && (append === null || (current && !next.startsWith(current + '\n\n')))) return { status: 'incompatible' };
    if (!compatible(current)) return { status: 'incompatible' };
    return { status: 'restore', old: current, value: next, conflict };
}

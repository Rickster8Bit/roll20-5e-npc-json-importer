// scripts/ImportNpcJson_SpellImporter.js
// Populates an NPC's spellbook by fetching data from dnd5eapi.co.
// Implements the design from SPELL_IMPORT_PLAN.md.
const ImportNpcJson_SpellImporter = {

    CACHE: {},

    slugify: function(name) {
        return name.toLowerCase()
            .replace(/['']/g, '')           // strip apostrophes (melf's → melfs)
            .replace(/[^a-z0-9]+/g, '-')    // non-alphanumeric → dash
            .replace(/^-+|-+$/g, '');       // trim leading/trailing dashes
    },

    // Returns { [levelKey]: [spellName, ...], ... }
    // levelKey is "cantrip" or "1"-"9".
    collectSpellNames: function(npcJson) {
        const result = {};

        const addSpell = (levelKey, rawName) => {
            const name = String(rawName).trim()
                .replace(/\*+/g, '')            // strip markdown italics
                .replace(/['']/g, "'")          // normalise quotes
                .replace(/\s+\(.*?\)$/, '')     // strip trailing "(3/day)" notes
                .trim();
            if (!name) return;
            if (!result[levelKey]) result[levelKey] = [];
            if (!result[levelKey].some(n => n.toLowerCase() === name.toLowerCase())) {
                result[levelKey].push(name);
            }
        };

        // Path 1: Structured "spells" field in JSON
        if (npcJson.spells && typeof npcJson.spells === 'object') {
            Object.entries(npcJson.spells).forEach(([level, names]) => {
                if (!Array.isArray(names)) return;
                const levelKey = (level === 'cantrips' || level === 'cantrip') ? 'cantrip' : String(parseInt(level, 10));
                names.forEach(n => addSpell(levelKey, n));
            });
            return result;
        }

        // Path 2: Parse the plain-text "Spellcasting" trait description (fallback)
        const spellcastingTrait = (npcJson.traits || []).find(t =>
            t.name && t.name.toLowerCase().includes('spellcasting') && t.desc
        );
        if (!spellcastingTrait) return result;

        const desc = spellcastingTrait.desc.replace(/\n/g, ' ');
        const blockRx = /\b(?:cantrips?|at will|[1-9](?:st|nd|rd|th)\s+level)\b[^:]*:\s*([^.]+)/gi;
        let match;
        while ((match = blockRx.exec(desc)) !== null) {
            const heading = match[0];
            const fragment = match[1];
            const headingLc = heading.toLowerCase();
            let levelKey;
            if (headingLc.includes('cantrip') || headingLc.includes('at will')) {
                levelKey = 'cantrip';
            } else {
                const numMatch = heading.match(/([1-9])(?:st|nd|rd|th)/i);
                levelKey = numMatch ? numMatch[1] : null;
            }
            if (!levelKey) continue;
            fragment.split(/\s*(?:,|;| or )\s*/).forEach(n => addSpell(levelKey, n));
        }

        return result;
    },

    // Fetches spell data from dnd5eapi.co, using CACHE to avoid duplicate requests.
    // Returns the parsed JSON on success, or null on any error / 404.
    // Roll20 API sandbox uses Node.js https.request — fetch() is not available.
    fetchSpell: function(slug) {
        if (ImportNpcJson_SpellImporter.CACHE[slug] !== undefined) {
            return Promise.resolve(ImportNpcJson_SpellImporter.CACHE[slug]);
        }
        return new Promise(function(resolve) {
            try {
                const https = require('https');
                const options = {
                    hostname: 'www.dnd5eapi.co',
                    path: '/api/spells/' + slug,
                    method: 'GET',
                    headers: { 'Accept': 'application/json' }
                };
                const req = https.request(options, function(res) {
                    if (res.statusCode !== 200) {
                        ImportNpcJson_SpellImporter.CACHE[slug] = null;
                        resolve(null);
                        return;
                    }
                    let body = '';
                    res.on('data', function(chunk) { body += chunk; });
                    res.on('end', function() {
                        try {
                            const data = JSON.parse(body);
                            ImportNpcJson_SpellImporter.CACHE[slug] = data;
                            resolve(data);
                        } catch(e) {
                            ImportNpcJson_SpellImporter.CACHE[slug] = null;
                            resolve(null);
                        }
                    });
                });
                req.on('error', function(err) {
                    ImportJSON_Utils.dbg('SpellImporter fetchSpell "' + slug + '": ' + err.message);
                    ImportNpcJson_SpellImporter.CACHE[slug] = null;
                    resolve(null);
                });
                req.end();
            } catch(e) {
                ImportJSON_Utils.dbg('SpellImporter fetchSpell require error: ' + e.message);
                ImportNpcJson_SpellImporter.CACHE[slug] = null;
                resolve(null);
            }
        });
    },

    // Returns true if a spell with this name already exists in the character's spellbook.
    spellExists: function(charId, spellName, levelKey) {
        const prefix = `repeating_spell-${levelKey}_`;
        return ImportJSON_Utils.global_findObjs({ _type: 'attribute', _characterid: charId })
            .some(a => {
                const n = a.get('name');
                return n && n.startsWith(prefix) && n.endsWith('_spellname') &&
                       a.get('current').toLowerCase() === spellName.toLowerCase();
            });
    },

    // Creates the `repeating_spell-<levelKey>_<rowId>_*` attributes for one spell.
    // Pass spellData=null to create a minimal placeholder (non-SRD spell).
    // Returns { rowId, sectionName, hasAttack } on success.
    createSpellbookEntry: function(charId, spellData, levelKey, overrideName) {
        const rowId = ImportJSON_Utils.genRowID();
        const sectionName = `repeating_spell-${levelKey}`;
        const prefix = `${sectionName}_${rowId}`;
        const createObj = ImportJSON_Utils.global_createObj;
        const dbg = ImportJSON_Utils.dbg;

        const setAttr = (key, value) => {
            if (value === undefined || value === null || value === '') return;
            createObj('attribute', {
                _characterid: charId,
                name: `${prefix}_${key}`,
                current: String(value)
            });
        };

        const spellName = overrideName || (spellData && spellData.name) || 'Unknown Spell';
        const spellLevel = spellData
            ? spellData.level
            : (levelKey === 'cantrip' ? 0 : parseInt(levelKey, 10) || 0);

        setAttr('spellname', spellName);
        setAttr('spelllevel', String(spellLevel));
        setAttr('options-flag', '0');
        setAttr('spellprepared', '1');

        if (!spellData) {
            // Non-SRD placeholder: just name and a note
            setAttr('spelldescription', '(Spell data not available in SRD)');
            dbg(`SpellImporter: Created placeholder for "${spellName}"`);
            return { rowId, sectionName, hasAttack: false };
        }

        if (spellData.school && spellData.school.name) {
            setAttr('spellschool', spellData.school.name);
        }
        setAttr('spellcastingtime', spellData.casting_time || '');
        setAttr('spellrange', spellData.range || '');
        setAttr('spellduration', spellData.duration || '');

        const comps = spellData.components || [];
        setAttr('spellcomp_v', comps.includes('V') ? '1' : '');
        setAttr('spellcomp_s', comps.includes('S') ? '1' : '');
        setAttr('spellcomp_m', comps.includes('M') ? '1' : '');
        if (spellData.material) setAttr('spellcomp_materials', spellData.material);

        setAttr('spellritual', spellData.ritual ? '1' : '');
        setAttr('spellconcentration', spellData.concentration ? '1' : '');

        if (spellData.desc && spellData.desc.length > 0) {
            setAttr('spelldescription', spellData.desc.join('\n\n'));
        }
        if (spellData.higher_level && spellData.higher_level.length > 0) {
            setAttr('spellathigherlevels', spellData.higher_level.join('\n\n'));
        }

        // Damage info (attack spells and some save spells)
        const dmgTable = (spellData.damage || {}).damage_at_slot_level
                      || (spellData.damage || {}).damage_at_character_level;
        if (dmgTable) {
            const firstKey = Object.keys(dmgTable).sort((a, b) => parseInt(a) - parseInt(b))[0];
            if (firstKey) setAttr('spelldamage', dmgTable[firstKey]);
        }
        if (spellData.damage && spellData.damage.damage_type && spellData.damage.damage_type.name) {
            setAttr('spelldamagetype', spellData.damage.damage_type.name);
        }

        // Healing spells
        if (spellData.heal_at_slot_level) {
            const healTable = spellData.heal_at_slot_level;
            const firstKey = Object.keys(healTable).sort((a, b) => parseInt(a) - parseInt(b))[0];
            if (firstKey) setAttr('spellhl', healTable[firstKey]);
        }

        // Save DC ability
        if (spellData.dc && spellData.dc.dc_type && spellData.dc.dc_type.name) {
            setAttr('spellsave', spellData.dc.dc_type.name.toUpperCase().substring(0, 3));
        }

        // Attack type ("ranged" or "melee")
        if (spellData.attack_type) {
            setAttr('spellattack', spellData.attack_type.toLowerCase());
        }

        // Rollbase for the spell sheet entry
        let rollbase = `@{wtype}&{template:spell} @{npc_name_flag} {{name=@{spellname}}} {{level=@{spelllevel}}} {{school=@{spellschool}}} {{castingtime=@{spellcastingtime}}} {{range=@{spellrange}}} {{duration=@{spellduration}}} {{comp_v=@{spellcomp_v}}} {{comp_s=@{spellcomp_s}}} {{comp_m=@{spellcomp_m}}} {{materials=@{spellcomp_materials}}} {{concentration=@{spellconcentration}}} {{ritual=@{spellritual}}} {{description=@{options-flag}}} @{charname_output}`;
        if (spellData.attack_type) {
            rollbase = `@{wtype}&{template:spell} @{npc_name_flag} {{name=@{spellname}}} {{level=@{spelllevel}}} {{school=@{spellschool}}} {{castingtime=@{spellcastingtime}}} {{range=@{spellrange}}} {{duration=@{spellduration}}} {{comp_v=@{spellcomp_v}}} {{comp_s=@{spellcomp_s}}} {{comp_m=@{spellcomp_m}}} {{materials=@{spellcomp_materials}}} {{concentration=@{spellconcentration}}} {{ritual=@{spellritual}}} {{attack=[[1d20+@{spell_attack_bonus}]]}} @{rtype}+@{spell_attack_bonus}]]}} {{damage=[[?{Damage Dice|@{spelldamage}}+0]]}} {{damagetype=@{spelldamagetype}}} {{description=@{options-flag}}} @{charname_output}`;
        }
        setAttr('rollbase', rollbase);

        dbg(`SpellImporter: Created spell "${spellName}" (level ${spellLevel}) row ${rowId}`);
        return { rowId, sectionName, hasAttack: !!spellData.attack_type };
    },

    // For attack spells: creates a `repeating_attack_*` row so the spell appears
    // in the NPC's "Attacks & Spellcasting" section with a clickable attack button.
    maybeCreateAttackEntry: function(charId, spellData, spellRowId, levelKey) {
        if (!spellData || !spellData.attack_type) return;

        const rowId = ImportJSON_Utils.genRowID();
        const prefix = `repeating_attack_${rowId}`;
        const createObj = ImportJSON_Utils.global_createObj;
        const dbg = ImportJSON_Utils.dbg;

        const setAttr = (key, value) => {
            if (value === undefined || value === null || value === '') return;
            createObj('attribute', {
                _characterid: charId,
                name: `${prefix}_${key}`,
                current: String(value)
            });
        };

        setAttr('atkname', spellData.name);
        setAttr('atkattr_base', 'spell');
        setAttr('atk_desc', '0');
        setAttr('atk_spelllevel', levelKey === 'cantrip' ? '0' : String(levelKey));
        setAttr('spellid', spellRowId);
        setAttr('atkrange', spellData.range || '');

        const dmgTable = (spellData.damage || {}).damage_at_slot_level
                      || (spellData.damage || {}).damage_at_character_level;
        if (dmgTable) {
            const firstKey = Object.keys(dmgTable).sort((a, b) => parseInt(a) - parseInt(b))[0];
            if (firstKey) setAttr('atkdmg', dmgTable[firstKey]);
        }
        if (spellData.damage && spellData.damage.damage_type && spellData.damage.damage_type.name) {
            setAttr('atkdmgtype', spellData.damage.damage_type.name);
        }

        const rollbase = `@{wtype}&{template:npcfullatk} {{attack=1}} {{damage=1}} {{dmg1flag=1}} @{npc_name_flag} {{rname=@{atkname}}} {{r1=[[@{d20}+@{spell_attack_bonus}]]}} @{rtype}+@{spell_attack_bonus}]]}} {{dmg1=[[@{atkdmg}+0]]}} {{dmg1type=@{atkdmgtype}}} @{charname_output}`;
        setAttr('rollbase', rollbase);

        ImportJSON_Utils.createLinkedAbility(
            charId, spellData.name,
            spellData.desc ? spellData.desc[0] : '',
            `%{${charId}|${prefix}_rollbase}`,
            createObj, dbg, true
        );

        dbg(`SpellImporter: Created attack entry for "${spellData.name}"`);
    },

    // Main entry point called during a fresh NPC import.
    importSpellsForCharacter: function(charId, npcJson, whisperFn) {
        const dbg = ImportJSON_Utils.dbg;
        dbg(`SpellImporter: Starting import for character ${charId}`);

        const spellsByLevel = ImportNpcJson_SpellImporter.collectSpellNames(npcJson);
        const allSpells = Object.entries(spellsByLevel)
            .flatMap(([level, names]) => names.map(name => ({ name, level })));

        if (allSpells.length === 0) {
            dbg('SpellImporter: No spells found to import.');
            return;
        }
        dbg(`SpellImporter: ${allSpells.length} spell(s) to process.`);

        const reporders = {};
        let successCount = 0;
        let skipCount = 0;
        let notFoundCount = 0;

        const finish = () => {
            // Write _reporder attributes so the sheet displays spells in the right order
            Object.entries(reporders).forEach(([levelKey, rowIds]) => {
                if (rowIds.length === 0) return;
                ImportJSON_Utils.setAttributeDirect(
                    charId,
                    `_reporder_repeating_spell-${levelKey}`,
                    rowIds.join(','),
                    ImportJSON_Utils.global_findObjs,
                    ImportJSON_Utils.global_createObj,
                    dbg
                );
            });
            whisperFn(`🔮 Spell import: <b>${successCount}</b> added, <b>${skipCount}</b> already existed, <b>${notFoundCount}</b> not in SRD (placeholders created).`);
        };

        const processNext = (index) => {
            if (index >= allSpells.length) { finish(); return; }

            const { name, level } = allSpells[index];
            const hintLevelKey = (level === 'cantrips' || level === 'cantrip') ? 'cantrip' : String(level);

            if (ImportNpcJson_SpellImporter.spellExists(charId, name, hintLevelKey)) {
                dbg(`SpellImporter: Skipping duplicate "${name}"`);
                skipCount++;
                processNext(index + 1);
                return;
            }

            const slug = ImportNpcJson_SpellImporter.slugify(name);
            ImportNpcJson_SpellImporter.fetchSpell(slug).then(spellData => {
                if (!spellData) {
                    // Non-SRD spell – create placeholder at the hinted level
                    notFoundCount++;
                    const res = ImportNpcJson_SpellImporter.createSpellbookEntry(charId, null, hintLevelKey, name);
                    if (res) {
                        if (!reporders[hintLevelKey]) reporders[hintLevelKey] = [];
                        reporders[hintLevelKey].push(res.rowId);
                    }
                } else {
                    // Use the API's authoritative level (overrides the hint from trait text)
                    const actualLevelKey = spellData.level === 0 ? 'cantrip' : String(spellData.level);
                    const res = ImportNpcJson_SpellImporter.createSpellbookEntry(charId, spellData, actualLevelKey);
                    if (res) {
                        if (!reporders[actualLevelKey]) reporders[actualLevelKey] = [];
                        reporders[actualLevelKey].push(res.rowId);
                        if (res.hasAttack) {
                            ImportNpcJson_SpellImporter.maybeCreateAttackEntry(charId, spellData, res.rowId, actualLevelKey);
                        }
                        successCount++;
                    }
                }
                // 200 ms between requests – polite to the free API
                setTimeout(() => processNext(index + 1), 200);
            });
        };

        processNext(0);
    },

    // Retro-fitter: populate spells for a character that was already imported
    // (reads the Spellcasting trait already on the sheet).
    importSpellsForExistingCharacter: function(charId, whisperFn) {
        const findObjs = ImportJSON_Utils.global_findObjs;

        // Find the Spellcasting trait row
        const traitNameAttrs = findObjs({ _type: 'attribute', _characterid: charId })
            .filter(a => {
                const n = a.get('name');
                return n && /^repeating_npctrait_[^_]+_name$/.test(n) &&
                       a.get('current').toLowerCase().includes('spellcasting');
            });

        if (traitNameAttrs.length === 0) {
            whisperFn('❌ No Spellcasting trait found on this character. Re-import with a "spells" field, or add spells manually.');
            return;
        }

        const traitRowId = traitNameAttrs[0].get('name').split('_')[2];
        const descAttr = findObjs({ _type: 'attribute', _characterid: charId,
                                    name: `repeating_npctrait_${traitRowId}_desc` })[0];

        const fakeNpcJson = {
            traits: [{
                name: traitNameAttrs[0].get('current'),
                desc: descAttr ? descAttr.get('current') : ''
            }]
        };

        ImportNpcJson_SpellImporter.importSpellsForCharacter(charId, fakeNpcJson, whisperFn);
    }
};

ImportJSON_Utils.dbg("ImportNpcJson_SpellImporter.js populated and loaded.");

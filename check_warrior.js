const fs = require('fs');
const html = fs.readFileSync('public/talents.html', 'utf8');

// Extract warrior section only
const warriorMatch = html.match(/warrior:\{[\s\S]*?(?=\npaladin:|\npriest:|\nhunter:|\nrogue:|\nmage:|\nwarlock:|\ndruid:|\nshaman:)/);
if (!warriorMatch) { console.log('Could not find warrior data'); process.exit(1); }

const warriorBlock = warriorMatch[0];
const icons = [...warriorBlock.matchAll(/icon:'([^']+)'/g), ...warriorBlock.matchAll(/icon:"([^"]+)"/g)].map(m => m[1]);
console.log('Warrior icons:', icons.length);

const PACK = 'public/images/WoW Vanilla_Classic Icon Pack/';
const _IF = {
  axe:'Weapons',axe2:'Weapons',sword:'Weapons',sword2:'Weapons',mace:'Weapons',mace2:'Weapons',
  bow:'Weapons',gun:'Weapons',staff:'Weapons',dagger:'Weapons',thrown:'Weapons',wand:'Weapons',fist:'Weapons',
  shield:'Armor',chest:'Armor',robe:'Armor',legs:'Armor',head:'Armor',shoulder:'Armor',
  hand:'Armor',feet:'Armor',back:'Armor',waist:'Armor',wrist:'Armor',neck:'Armor',finger:'Armor',trinket:'Armor',
  bag:'Items',container:'Items',potion:'Items',herb:'Trade',leather:'Trade',cloth:'Trade',
  ore:'Trade',metal:'Trade',stone:'Trade',crystal:'Items',jewelcrafting:'Items',food:'Items'
};

function getFolder(n) {
  if (n.startsWith('classicon_')) return { dir: 'public/images/talents/', file: n };
  let f;
  if (n.startsWith('ability_')) f = 'Abilities';
  else if (n.startsWith('spell_') || n.startsWith('racial_')) f = 'Spells';
  else if (n.startsWith('inv_')) {
    const p = n.split('_');
    f = _IF[p[1]] || (p[1]==='misc' ? (p[2]==='pelt'?'Trade':p[2]==='cape'?'Armor':'Items') : 'Items');
  }
  return { dir: PACK + (f||'Icons') + '/', file: n };
}

// Build case-insensitive set per folder
const dirCache = {};
function filesIn(dir) {
  if (!dirCache[dir]) {
    try { dirCache[dir] = new Set(fs.readdirSync(dir).map(f=>f.toLowerCase())); }
    catch(e) { dirCache[dir] = new Set(); }
  }
  return dirCache[dir];
}

for (const icon of icons) {
  const { dir, file } = getFolder(icon);
  const files = filesIn(dir);
  const hasWebp = files.has(file + '.webp');
  const hasJpg = files.has(file + '.jpg');
  if (!hasWebp && !hasJpg) {
    // search all folders
    const allFolders = ['Abilities','Spells','Items','Weapons','Armor','Trade','Icons'].map(f=>PACK+f+'/');
    allFolders.push('public/images/talents/');
    let found = null;
    for (const d of allFolders) {
      const fs2 = filesIn(d);
      if (fs2.has(file+'.webp')) { found = d+'(webp)'; break; }
      if (fs2.has(file+'.jpg')) { found = d+'(jpg)'; break; }
    }
    console.log('MISSING:', icon, '| expected:', dir, '| found elsewhere:', found||'NOWHERE');
  } else {
    console.log('OK:', icon, hasWebp?'webp':'jpg');
  }
}

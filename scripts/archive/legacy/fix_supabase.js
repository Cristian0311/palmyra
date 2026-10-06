import fs from 'fs';

let content = fs.readFileSync('src/store/useStore.ts', 'utf8');

// A generic regex might be too complex. Let's just find `await supabase.from('branches').insert`
content = content.replace(/await supabase\.from\('branches'\)\.insert\(\[\{\n\s+id: branch\.id,\n\s+name: branch\.name,\n\s+address: branch\.address,\n\s+phone: branch\.phone\n\s+\}\]\);/g, 
`const { error } = await supabase.from('branches').insert([{
        id: branch.id,
        name: branch.name,
        address: branch.address,
        phone: branch.phone
      }]);
      if (error) throw error;`);

content = content.replace(/await supabase\.from\('branches'\)\.update\(\w+\)\.eq\('id', id\);/g, 
`const { error } = await supabase.from('branches').update(updateData).eq('id', id);
      if (error) throw error;`);

content = content.replace(/await supabase\.from\('branches'\)\.delete\(\)\.eq\('id', id\);/g, 
`const { error } = await supabase.from('branches').delete().eq('id', id);
      if (error) throw error;`);

fs.writeFileSync('src/store/useStore.ts', content);
console.log("Supabase branch handlers fixed");

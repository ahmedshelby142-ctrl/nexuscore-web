import os
import re

exports = set()
types_dir = 'src'
for root, dirs, files in os.walk(types_dir):
    for f in files:
        if f.endswith('.ts') or f.endswith('.tsx'):
            path = os.path.join(root, f)
            with open(path, 'r', encoding='utf-8') as file:
                content = file.read()
                matches = re.finditer(r'import\s+(?:type\s+)?{([^}]+)}\s+from\s+[\"\'\'](.*types(?:\/index)?)[\"\'\']', content)
                for match in matches:
                    items = match.group(1).split(',')
                    for item in items:
                        item = item.strip()
                        if ' as ' in item:
                            item = item.split(' as ')[0].strip()
                        if item:
                            exports.add(item)
print('Found', len(exports), 'exported types:')
for e in sorted(exports):
    print(e)

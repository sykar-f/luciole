# Rewrites the starter's cache invalidation with a name the installed core does not export, as
# code written against an older API reads after the bump.
set -eu
sed -e 's/getSession, invalidate }/getSession, revalidateTag }/' \
  -e 's/invalidate({ tag: \([^}]*\) })/revalidateTag(\1)/' actions/notes.ts > actions/notes.ts.new
mv actions/notes.ts.new actions/notes.ts

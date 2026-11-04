#!/bin/bash

# site:
#     type: user_program
#     working_directory: '{INSTALL_PATH_RELATIVE}'
#     command: './start.sh'
# requirements:
#     disk: 60
# form:
#     language:
#         type: choices
#         label:
#             en: Language of your Atlas
#             fr: Langue de ton Atlas
#         choices:
#             fr: Français
#             en: English
#     email:
#         type: email
#         label:
#             en: Your email (to sign in)
#             fr: Ton email (pour te connecter)
#         max_length: 254
#     password:
#         type: password
#         label:
#             en: Your password (8 characters or more)
#             fr: Ton mot de passe (8 caractères ou plus)
#         min_length: 8
#         max_length: 128
#     prefix:
#         label:
#             en: Name shown before "Atlas" (optional, your first name for instance)
#             fr: Nom affiché avant « Atlas » (facultatif, ton prénom par exemple)
#         required: false
#         max_length: 40
#     tagline:
#         label:
#             en: Line under the logo (optional)
#             fr: Phrase sous le logo (facultatif)
#         required: false
#         max_length: 160

# Atlas Mind from the alwaysdata marketplace: the engine in a virtualenv, a new mind on
# the account's disk (no GitHub needed, one can be connected later), its first admin
# from the form, and the start script the site runs. Nothing to type in a terminal.
set -e

# The proxy hands the program the full path (/atlas/api/…), and Atlas serves from the root.
if [ -n "${INSTALL_URL_PATH%/}" ]; then
    echo "Atlas must be installed at the root of its address (${INSTALL_URL_HOSTNAME}), not under ${INSTALL_URL_PATH}." >&2
    echo "Atlas doit être installé à la racine de son adresse (${INSTALL_URL_HOSTNAME}), pas sous ${INSTALL_URL_PATH}." >&2
    exit 1
fi

# ATLAS_PIP_SPEC lets a test install a branch (git+https://…@branch) instead of PyPI.
ATLAS_PIP_SPEC="${ATLAS_PIP_SPEC:-atlas-mind}"

python3 -m venv "$INSTALL_PATH/venv"
"$INSTALL_PATH/venv/bin/pip" install --quiet --no-cache-dir --upgrade pip
"$INSTALL_PATH/venv/bin/pip" install --quiet --no-cache-dir "$ATLAS_PIP_SPEC"

"$INSTALL_PATH/venv/bin/atlas" init "$INSTALL_PATH/mind" --lang "$FORM_LANGUAGE" \
    --prefix "${FORM_PREFIX:-}" --tagline "${FORM_TAGLINE:-}" --yes
# Through stdin: a password in argv would show in the process list.
printf '%s\n' "$FORM_PASSWORD" | "$INSTALL_PATH/venv/bin/atlas" user add "$INSTALL_PATH/mind" \
    --email "$FORM_EMAIL" --role admin --password -

umask 077
"$INSTALL_PATH/venv/bin/python" -c "import secrets; print(secrets.token_hex(32))" \
    > "$INSTALL_PATH/.session-secret"

# alwaysdata hands the program its address in IP (IPv6 only) and PORT; the real client
# address arrives in X-Real-IP, which its proxy overwrites (X-Forwarded-For it does not).
cat > "$INSTALL_PATH/start.sh" <<EOF
#!/bin/sh
export ATLAS_BIND="\${IP:-::}" PORT="\${PORT:-8100}"
export KB_AUTH_ENABLED=1 KB_REPO_PATH="$INSTALL_PATH/mind" ATLAS_STORE=file
export ATLAS_TRUSTED_IP_HEADER=X-Real-IP PYTHONUNBUFFERED=1 ATLAS_UPDATE_CHECK=1
export SESSION_SECRET="\$(cat "$INSTALL_PATH/.session-secret")"
exec "$INSTALL_PATH/venv/bin/python" -m atlas_mind.server
EOF
chmod 700 "$INSTALL_PATH/start.sh"

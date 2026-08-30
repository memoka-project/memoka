#!/usr/bin/env sh
set -eu

tool_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_root=${MEMOKA_PROJECT_ROOT:-$(CDPATH= cd -- "$tool_dir/../.." && pwd)}
real_plugin=${MEMOKA_APPIMAGE_PLUGIN_REAL:-$tool_dir/appimage-output-real-x86_64.AppImage}
app_dir=
expect_app_dir=0

for argument in "$@"; do
  if [ "$expect_app_dir" -eq 1 ]; then
    app_dir=$argument
    expect_app_dir=0
    continue
  fi
  case "$argument" in
    --appdir)
      expect_app_dir=1
      ;;
    --appdir=*)
      app_dir=${argument#--appdir=}
      ;;
  esac
done

if [ -n "$app_dir" ]; then
  node "$project_root/scripts/sanitize-linux-appdir.mjs" "$app_dir"
fi

export APPIMAGE_EXTRACT_AND_RUN=${APPIMAGE_EXTRACT_AND_RUN:-1}
exec "$real_plugin" "$@"

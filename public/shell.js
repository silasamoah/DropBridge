const tabs = ['files', 'clipboard'];
function select(name) {
  for (const tab of tabs) {
    document.getElementById(tab).hidden = tab !== name;
    document.getElementById(tab + '-tab').setAttribute('aria-pressed', String(tab === name));
  }
  history.replaceState(null, '', '#' + name);
}
for (const tab of tabs) document.getElementById(tab + '-tab').onclick = () => select(tab);
select(location.hash === '#clipboard' ? 'clipboard' : 'files');

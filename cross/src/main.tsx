import { render } from 'preact';
import './styles.css';
import { initPlatform } from './app/platform';
import { App } from './ui/App';
import { startUpdateChecks } from './ui/Update';

void initPlatform().then((p) => {
  document.documentElement.dataset.platform = p.kind;
  render(<App />, document.getElementById('app')!);
  startUpdateChecks();
});

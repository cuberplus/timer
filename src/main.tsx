import { createRoot } from 'react-dom/client';
import 'bootstrap/dist/css/bootstrap.min.css';
import './style.css';
import App from './App';

document.documentElement.setAttribute('data-bs-theme', 'dark');
createRoot(document.getElementById('root')!).render(<App />);

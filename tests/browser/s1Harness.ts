// Imported only by the explicit isolated test build. Never a production API.
import { storageService } from '../../services/storage';
Object.assign(window, { __s1Storage: storageService });

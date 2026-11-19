/** TRACE 2.4: import ESM espliciti per il runtime Node.js; logica operativa invariata. */
/** FANTASMIA TRACE – AI/lib/traceCatalog.ts – rev 0.6. Catalogo pilota chiuso. */
const points = new Set(['WEB/browser/global','WEB/auth/login','WEB/auth/logout','WEB/indexedDB/read','WEB/indexedDB/write','WEB/indexedDB/delete','WEB/creativeMedia/improveStory','AI/improve-text.ts/handler','AI/improve-text.ts/callOpenAI']);

// Rev 1.1: funzioni IndexedDB osservate, catalogo chiuso.
points.add('WEB/indexedDB/clearAllAGStories');
points.add('WEB/indexedDB/clearNonSuperuserProfiles');
points.add('WEB/indexedDB/deleteAGStoriesBySource');
points.add('WEB/indexedDB/deleteAGStory');
points.add('WEB/indexedDB/deleteAMStory');
points.add('WEB/indexedDB/deleteASStory');
points.add('WEB/indexedDB/deleteAlbum');
points.add('WEB/indexedDB/deleteDailyStory');
points.add('WEB/indexedDB/deleteGroupStory');
points.add('WEB/indexedDB/deleteGroupStoryContribution');
points.add('WEB/indexedDB/deleteMediaAsset');
points.add('WEB/indexedDB/deleteMediaAssetsByStoryId');
points.add('WEB/indexedDB/deleteProfile');
points.add('WEB/indexedDB/detectStoryType');
points.add('WEB/indexedDB/ensureDailyStoriesLoaded');
points.add('WEB/indexedDB/getAGStoriesByCategory');
points.add('WEB/indexedDB/getAGStoryById');
points.add('WEB/indexedDB/getAMStoriesByUser');
points.add('WEB/indexedDB/getAMStoryById');
points.add('WEB/indexedDB/getASStoriesByCategory');
points.add('WEB/indexedDB/getASStoriesByCreator');
points.add('WEB/indexedDB/getASStoryById');
points.add('WEB/indexedDB/getAlbumById');
points.add('WEB/indexedDB/getAlbums');
points.add('WEB/indexedDB/getAllAGStories');
points.add('WEB/indexedDB/getAllAMStories');
points.add('WEB/indexedDB/getAllASStories');
points.add('WEB/indexedDB/getAllDailyStories');
points.add('WEB/indexedDB/getAllGroupStories');
points.add('WEB/indexedDB/getAllMediaAssets');
points.add('WEB/indexedDB/getContributionsByGroupStoryId');
points.add('WEB/indexedDB/getDailyStoryByDate');
points.add('WEB/indexedDB/getGroupStoriesByStatus');
points.add('WEB/indexedDB/getGroupStoryById');
points.add('WEB/indexedDB/getMediaAssetsByStoryId');
points.add('WEB/indexedDB/getMediaCountByStoryId');
points.add('WEB/indexedDB/getProfiles');
points.add('WEB/indexedDB/getSystemSettings');
points.add('WEB/indexedDB/importDailyStories');
points.add('WEB/indexedDB/saveAGStory');
points.add('WEB/indexedDB/saveAMStory');
points.add('WEB/indexedDB/saveASStory');
points.add('WEB/indexedDB/saveAlbum');
points.add('WEB/indexedDB/saveDailyStory');
points.add('WEB/indexedDB/saveGroupStory');
points.add('WEB/indexedDB/saveGroupStoryContribution');
points.add('WEB/indexedDB/saveMediaAsset');
points.add('WEB/indexedDB/saveMediaAssetWithStoryUpdate');
points.add('WEB/indexedDB/saveMediaFromPreview');
points.add('WEB/indexedDB/saveProfile');
points.add('WEB/indexedDB/saveSystemSettings');
points.add('WEB/indexedDB/updateStoryImageStatus');
export function allowedPoint(source:string,module:string,fn:string):boolean{return points.has(`${source}/${module}/${fn}`);}
export function allowedMetadata(request:string,build:string):boolean{return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request)&&build==='trace-pilot-06';}

points.add('WEB/creativeMedia/generatePoetry');

// Rev 1.9: generazione disegni WEB.
points.add('WEB/creativeMedia/generateDrawing');
points.add('WEB/creativeMedia/generateDailyDrawing');
points.add('WEB/creativeMedia/generateArchiveDrawing');

import {generatedPoints} from './traceGeneratedCatalog.js';
for(const p of generatedPoints)points.add(p.join('/'));

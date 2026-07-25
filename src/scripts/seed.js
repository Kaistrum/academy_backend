/**
 * Development seed. `pnpm seed` upserts; `pnpm seed:fresh` wipes the
 * collections first. Content mirrors Kaistrum's real geospatial catalogue.
 */
import env from '../config/env.js';
import { closeDatabase, connectDatabase, getDb } from '../db/client.js';
import {
  COLLECTIONS,
  Courses,
  Enrollments,
  Instructors,
  Lessons,
  Tracks,
  Users,
} from '../db/collections.js';
import { ensureIndexes } from '../db/indexes.js';
import { recomputeCourseAggregates } from '../lib/aggregates.js';
import { hashPassword } from '../lib/password.js';

const FRESH = process.argv.includes('--fresh');

const TRACKS = [
  {
    slug: 'mapping',
    name: 'Mapping & Cartography',
    icon: 'Map',
    blurb: 'Design maps that communicate — symbology, layout and cartographic craft.',
    sortOrder: 1,
  },
  {
    slug: 'spatial-analysis',
    name: 'Spatial Analysis & Data Science',
    icon: 'ChartScatter',
    blurb: 'Turn coordinates into decisions with statistics, modelling and Python.',
    sortOrder: 2,
  },
  {
    slug: 'remote-sensing',
    name: 'Remote Sensing',
    icon: 'Satellite',
    blurb: 'Work with satellite and drone imagery from acquisition to classification.',
    sortOrder: 3,
  },
  {
    slug: 'surveying',
    name: 'Surveying & GNSS',
    icon: 'Compass',
    blurb: 'Field data capture, GNSS positioning and survey adjustment.',
    sortOrder: 4,
  },
  {
    slug: 'web-gis',
    name: 'Web GIS & Development',
    icon: 'Code2',
    blurb: 'Publish spatial data to the web with GeoServer, PostGIS and Leaflet.',
    sortOrder: 5,
  },
];

const INSTRUCTORS = [
  {
    key: 'wanjiru',
    name: 'Dr. Grace Wanjiru',
    title: 'Lead GIS Analyst',
    bio: 'Fifteen years mapping land use across East Africa, and a stubborn believer that a good legend saves a bad map.',
    email: 'grace.wanjiru@kaistrum.com',
  },
  {
    key: 'otieno',
    name: 'Brian Otieno',
    title: 'Remote Sensing Specialist',
    bio: 'Works with Sentinel and Landsat archives on agricultural monitoring programmes.',
    email: 'brian.otieno@kaistrum.com',
  },
  {
    key: 'mwende',
    name: 'Faith Mwende',
    title: 'Geospatial Developer',
    bio: 'Builds the pipelines and web maps that put field data in front of decision makers.',
    email: 'faith.mwende@kaistrum.com',
  },
];

const html = (paragraphs) => paragraphs.map((p) => `<p>${p}</p>`).join('');

const COURSES = [
  {
    slug: 'introduction-to-gis',
    title: 'Introduction to GIS',
    summary:
      'Start from zero: coordinate systems, vector and raster data, and your first analysis in QGIS.',
    track: 'mapping',
    instructor: 'wanjiru',
    format: 'web_course',
    level: 'beginner',
    premium: false,
    featured: true,
    description: [
      'Geographic Information Systems sound intimidating until you realise they are mostly tables with a location column.',
      'This course walks through the concepts you will use every day — projections, data models, attribute joins — and puts each one to work on a real Nairobi land-use dataset.',
    ],
    whatYouLearn: [
      'Explain the difference between geographic and projected coordinate systems',
      'Load, style and query vector and raster layers in QGIS',
      'Perform attribute and spatial joins',
      'Produce a print-ready map with a legend, scale bar and north arrow',
    ],
    requirements: ['A computer that can run QGIS (free)', 'No prior GIS experience needed'],
    faqs: [
      {
        question: 'Do I need to buy ArcGIS?',
        answer: 'No. Every exercise uses QGIS, which is free and open source.',
      },
    ],
    lessons: [
      ['Foundations', 0, 'What GIS actually is', 12, true],
      ['Foundations', 0, 'Coordinate systems and projections', 22, true],
      ['Foundations', 0, 'Vector vs raster data models', 18, false],
      ['Working with data', 1, 'Loading and styling layers', 25, false],
      ['Working with data', 1, 'Attribute tables and joins', 28, false],
      ['Working with data', 1, 'Spatial queries', 24, false],
      ['Making maps', 2, 'Symbology that communicates', 20, false],
      ['Making maps', 2, 'Print layouts and export', 26, false],
    ],
  },
  {
    slug: 'fundamentals-of-arcgis',
    title: 'Fundamentals of ArcGIS Pro',
    summary:
      'Hands-on ArcGIS Pro: projects, geoprocessing, geodatabases and the analysis workflows employers ask for.',
    track: 'mapping',
    instructor: 'wanjiru',
    format: 'training_seminar',
    level: 'intermediate',
    premium: true,
    priceKES: 12_500,
    originalPriceKES: 18_000,
    featured: true,
    description: [
      'ArcGIS Pro is the industry standard across government and consultancy work in the region.',
      'Eleven exercises take you from an empty project to a documented geoprocessing model you can hand to a colleague.',
    ],
    whatYouLearn: [
      'Structure projects and file geodatabases properly',
      'Run and chain geoprocessing tools',
      'Build repeatable workflows with ModelBuilder',
      'Share results as web layers',
    ],
    requirements: ['An ArcGIS Pro licence (a 21-day trial is fine)', 'Basic GIS concepts'],
    faqs: [
      {
        question: 'Is this enough for the Esri certification?',
        answer: 'It covers most of the Desktop Associate syllabus, but plan additional practice.',
      },
    ],
    lessons: [
      ['Getting oriented', 0, 'Projects, maps and layouts', 18, true],
      ['Getting oriented', 0, 'The geodatabase model', 24, false],
      ['Geoprocessing', 1, 'Core tools: buffer, clip, dissolve', 30, false],
      ['Geoprocessing', 1, 'Overlay analysis', 32, false],
      ['Geoprocessing', 1, 'ModelBuilder basics', 28, false],
      ['Sharing', 2, 'Publishing web layers', 22, false],
    ],
  },
  {
    slug: 'remote-sensing-with-sentinel',
    title: 'Remote Sensing with Sentinel Imagery',
    summary:
      'Acquire, correct and classify Sentinel-2 imagery for vegetation and land-cover monitoring.',
    track: 'remote-sensing',
    instructor: 'otieno',
    format: 'web_course',
    level: 'intermediate',
    premium: true,
    priceKES: 9_900,
    featured: true,
    description: [
      'Free Sentinel-2 imagery has changed what a small team can monitor.',
      'You will build a supervised land-cover classification end to end, and learn how to tell a real change from a cloud shadow.',
    ],
    whatYouLearn: [
      'Search and download Sentinel-2 scenes',
      'Apply atmospheric correction',
      'Compute NDVI and other spectral indices',
      'Run and validate a supervised classification',
    ],
    requirements: ['Comfort with basic GIS software', 'A Copernicus account (free)'],
    faqs: [],
    lessons: [
      ['Imagery basics', 0, 'How sensors see', 20, true],
      ['Imagery basics', 0, 'Bands, resolution and trade-offs', 24, false],
      ['Preprocessing', 1, 'Downloading Sentinel-2 scenes', 18, false],
      ['Preprocessing', 1, 'Atmospheric correction', 26, false],
      ['Analysis', 2, 'Spectral indices and NDVI', 22, false],
      ['Analysis', 2, 'Supervised classification', 34, false],
      ['Analysis', 2, 'Accuracy assessment', 28, false],
    ],
  },
  {
    slug: 'gnss-surveying-practical',
    title: 'GNSS Surveying: A Practical Guide',
    summary:
      'Static, RTK and post-processed GNSS workflows, with the error sources that actually bite in the field.',
    track: 'surveying',
    instructor: 'wanjiru',
    format: 'training_seminar',
    level: 'advanced',
    premium: true,
    priceKES: 15_000,
    description: [
      'Centimetre accuracy is less about the receiver than about understanding what degrades the signal.',
      'This seminar covers observation planning, field procedure and post-processing against CORS reference data.',
    ],
    whatYouLearn: [
      'Plan observation sessions around satellite geometry',
      'Run static and RTK surveys correctly',
      'Post-process baselines against CORS data',
      'Transform between global and local datums',
    ],
    requirements: ['Surveying fundamentals', 'Access to a GNSS receiver is helpful but optional'],
    faqs: [],
    lessons: [
      ['Signals', 0, 'GNSS constellations and signals', 22, true],
      ['Signals', 0, 'Error sources and mitigation', 26, false],
      ['Fieldwork', 1, 'Static observation procedure', 30, false],
      ['Fieldwork', 1, 'RTK and network RTK', 28, false],
      ['Processing', 2, 'Baseline processing', 32, false],
      ['Processing', 2, 'Datum transformation', 24, false],
    ],
  },
  {
    slug: 'web-mapping-with-geoserver',
    title: 'Web Mapping with GeoServer',
    summary:
      'Publish PostGIS data as OGC services and consume them in a Leaflet front end.',
    track: 'web-gis',
    instructor: 'mwende',
    format: 'web_course',
    level: 'intermediate',
    premium: true,
    priceKES: 11_000,
    description: [
      'A map that lives on one analyst’s laptop helps nobody.',
      'You will stand up PostGIS and GeoServer, publish WMS and WFS layers, style them with SLD, and wire the result into a Leaflet application.',
    ],
    whatYouLearn: [
      'Install and configure GeoServer',
      'Publish PostGIS tables as WMS and WFS',
      'Style layers with SLD',
      'Build a Leaflet client against your own services',
    ],
    requirements: ['Basic SQL', 'Comfort with the command line'],
    faqs: [
      {
        question: 'Do I need to know JavaScript?',
        answer: 'Enough to follow along. The Leaflet code is provided and explained line by line.',
      },
    ],
    lessons: [
      ['Setup', 0, 'PostGIS and GeoServer installation', 26, true],
      ['Setup', 0, 'Loading spatial data into PostGIS', 24, false],
      ['Services', 1, 'Publishing WMS layers', 22, false],
      ['Services', 1, 'WFS and transactional editing', 28, false],
      ['Services', 1, 'Styling with SLD', 30, false],
      ['Client', 2, 'A Leaflet front end', 32, false],
      ['Client', 2, 'Performance and caching', 20, false],
    ],
  },
  {
    slug: 'spatial-analysis-with-python',
    title: 'Spatial Analysis with Python',
    summary:
      'GeoPandas, Shapely and rasterio for analysts who have outgrown clicking through dialogs.',
    track: 'spatial-analysis',
    instructor: 'mwende',
    format: 'learning_path',
    level: 'advanced',
    premium: false,
    description: [
      'Anything you do twice in a GIS interface is worth scripting.',
      'This path builds a reproducible analysis pipeline in Python, from reading shapefiles to publishing a rendered result.',
    ],
    whatYouLearn: [
      'Read and write spatial formats with GeoPandas',
      'Run geometric operations with Shapely',
      'Process rasters with rasterio',
      'Package an analysis as a reproducible notebook',
    ],
    requirements: ['Python fundamentals', 'Basic GIS concepts'],
    faqs: [],
    lessons: [
      ['Python for spatial data', 0, 'Environment setup', 16, true],
      ['Python for spatial data', 0, 'GeoPandas essentials', 30, false],
      ['Geometry', 1, 'Shapely operations', 28, false],
      ['Geometry', 1, 'Spatial joins and overlays', 26, false],
      ['Rasters', 2, 'Reading rasters with rasterio', 24, false],
      ['Rasters', 2, 'Zonal statistics', 26, false],
      ['Delivery', 3, 'Reproducible notebooks', 20, false],
    ],
  },
];

async function wipe() {
  const db = getDb();
  for (const name of Object.values(COLLECTIONS)) {
    await db.collection(name).deleteMany({});
  }
  console.info('  cleared all collections');
}

async function upsertUser({ name, email, password, role }) {
  const now = new Date();
  const existing = await Users().findOne({ email });
  if (existing) return existing;

  const doc = {
    name,
    email,
    passwordHash: await hashPassword(password),
    role,
    avatarUrl: null,
    emailVerifiedAt: now,
    instructorProfileId: null,
    createdAt: now,
    updatedAt: now,
  };
  const result = await Users().insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

async function main() {
  await connectDatabase();
  await ensureIndexes();

  console.info(`Seeding ${env.MONGODB_DB}${FRESH ? ' (fresh)' : ''}…`);
  if (FRESH) await wipe();

  const now = new Date();

  // ---- tracks --------------------------------------------------------------
  const trackIds = new Map();
  for (const track of TRACKS) {
    const doc = await Tracks().findOneAndUpdate(
      { slug: track.slug },
      { $set: { ...track, updatedAt: now }, $setOnInsert: { courseCount: 0, createdAt: now } },
      { upsert: true, returnDocument: 'after' },
    );
    trackIds.set(track.slug, doc._id);
  }
  console.info(`  tracks: ${TRACKS.length}`);

  // ---- instructors ---------------------------------------------------------
  const instructorIds = new Map();
  for (const tutor of INSTRUCTORS) {
    const { key, ...profile } = tutor;
    const doc = await Instructors().findOneAndUpdate(
      { email: profile.email },
      {
        $set: { ...profile, avatarUrl: null, updatedAt: now },
        $setOnInsert: {
          userId: null,
          ratingAvg: 0,
          studentsCount: 0,
          coursesCount: 0,
          createdAt: now,
        },
      },
      { upsert: true, returnDocument: 'after' },
    );
    instructorIds.set(key, doc._id);
  }
  console.info(`  instructors: ${INSTRUCTORS.length}`);

  // ---- accounts ------------------------------------------------------------
  const admin = await upsertUser({
    name: 'Kaistrum Admin',
    email: (process.env.SEED_ADMIN_EMAIL ?? 'admin@kaistrum.com').toLowerCase(),
    password: process.env.SEED_ADMIN_PASSWORD ?? 'Admin12345',
    role: 'admin',
  });

  const tutorUser = await upsertUser({
    name: 'Dr. Grace Wanjiru',
    email: 'grace.wanjiru@kaistrum.com',
    password: 'Tutor12345',
    role: 'instructor',
  });

  // Link the login to the tutor profile so ownership scoping has something to test.
  await Users().updateOne(
    { _id: tutorUser._id },
    { $set: { instructorProfileId: instructorIds.get('wanjiru'), updatedAt: now } },
  );
  await Instructors().updateOne(
    { _id: instructorIds.get('wanjiru') },
    { $set: { userId: tutorUser._id, updatedAt: now } },
  );

  const learner = await upsertUser({
    name: 'Sam Kinyanjui',
    email: 'learner@kaistrum.com',
    password: 'Learner12345',
    role: 'learner',
  });
  console.info('  accounts: admin, instructor, learner');

  // ---- courses & lessons ---------------------------------------------------
  for (const course of COURSES) {
    const { lessons, track, instructor, ...fields } = course;

    const doc = await Courses().findOneAndUpdate(
      { slug: course.slug },
      {
        $set: {
          ...fields,
          contentHTML: html(course.description),
          trackId: trackIds.get(track),
          instructorId: instructorIds.get(instructor),
          premium: Boolean(course.premium),
          priceKES: course.premium ? course.priceKES : null,
          originalPriceKES: course.premium ? (course.originalPriceKES ?? null) : null,
          featured: Boolean(course.featured),
          status: 'published',
          faqs: (course.faqs ?? []).map((f, i) => ({ ...f, sortOrder: i })),
          publishedAt: now,
          updatedAt: now,
        },
        $setOnInsert: {
          ratingAvg: 0,
          ratingCount: 0,
          learnersCount: 0,
          durationMinutes: 0,
          lessonCount: 0,
          createdAt: now,
        },
      },
      { upsert: true, returnDocument: 'after' },
    );

    await Lessons().deleteMany({ courseId: doc._id });
    await Lessons().insertMany(
      lessons.map(([sectionTitle, sectionOrder, title, minutes, isPreview], index) => ({
        courseId: doc._id,
        sectionTitle,
        sectionOrder,
        title,
        minutes,
        isPreview,
        videoUrl: null,
        contentHTML: html([
          `<strong>${title}</strong> — ${minutes} minutes.`,
          'Replace this placeholder with the real Tiptap lesson body from the authoring tool.',
        ]),
        order: index,
        createdAt: now,
        updatedAt: now,
      })),
    );

    await recomputeCourseAggregates(doc._id);
  }
  console.info(`  courses: ${COURSES.length} (with lessons)`);

  // ---- a learner part-way through a course ---------------------------------
  const introCourse = await Courses().findOne({ slug: 'introduction-to-gis' });
  const introLessons = await Lessons()
    .find({ courseId: introCourse._id })
    .sort({ sectionOrder: 1, order: 1 })
    .toArray();

  const done = introLessons.slice(0, 3).map((l) => l._id);
  await Enrollments().updateOne(
    { userId: learner._id, courseId: introCourse._id },
    {
      $set: {
        status: 'active',
        completedLessonIds: done,
        completedLessons: done.length,
        progressPct: Math.round((done.length / introLessons.length) * 100),
        lastAccessedAt: now,
        updatedAt: now,
      },
      $setOnInsert: { enrolledAt: now, completedAt: null, paymentId: null, createdAt: now },
    },
    { upsert: true },
  );
  await recomputeCourseAggregates(introCourse._id);

  console.info('\nDone. Sign in with:');
  console.info(`  admin      ${admin.email} / ${process.env.SEED_ADMIN_PASSWORD ?? 'Admin12345'}`);
  console.info('  instructor grace.wanjiru@kaistrum.com / Tutor12345');
  console.info('  learner    learner@kaistrum.com / Learner12345');

  await closeDatabase();
}

main().catch(async (err) => {
  console.error('Seed failed:', err);
  await closeDatabase().catch(() => {});
  process.exit(1);
});

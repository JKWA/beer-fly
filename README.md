

# [Beer-Fly](https://www.beer-fly.com/)

 Beer-Fly is a progressive web app built to launch quickly, respond instantly, and can be accessed from anywhere on all devices and network conditions. It takes advantage of HTML web components, service workers and HTTP/2.

### With Beer-Fly:
* Users can: 
  * Find great craft beer breweries and pubs anywhere in the world.
  * Rate and track their favorite beers and breweries.
  * Create and find beer-crawls by location.
  * Share information with friends through messaging or email.

* Brewery owners can:
  * Update their brewery's tap-list, menu, food-trucks, and images images.
  * Cast tap-lists in real time to televisions or monitors.
  * Use Beer-Fly's api to incorporate tap-list information into their own sites.
  * Purchase improved services through a monthly subscription.

* Food-truck owners can update their schedule, geo-location, and menu.



## Beer-Fly Uses

- [Polymer](#polymer)
- [Firebase](#firebase)
- [BigQuery and StackDriver](#bigquery-and-stackdriver)
- [Github and TravisCLI](#github-and-travis-ci)
- [Google Place API](#google-place-api)
- [Material Design](#material-design)


## Polymer

Beer-Fly is built with Polymer, a JavaScript library designed to work "close to the metal."  Polymer sugars web components, including HTML templates, shadow DOM, event listeners, and application state.  Beer-Fly focuses on one-way binding with app state managed by Firebase. To facilitate sharing information, important parameters are encoded in the url.  Beer-Fly uses service workers, local storage, and offline caching.
 

## Firebase

Beer-Fly uses Firebase's suite of tools to manage user authentication, save and secure data, and run server-side functions.

### Auth
* Google, Facebook, and Email login
* Email Verification

### NoSQL Database
* Real-time updates

### Google Storage
* Used to store user submitted images

### Functions
* Manage user accounts
* Webhooks for credit card payment processing (Stripe)
* Process images (Save user images in Google Storage, check for appropriateness, create base64 thumbnails, and create public link)
* Remove inappropriate language from user submitted content
* Respond to API requests 
* Update and manage data 


### Hosting
* Beer-Fly uses Firebase's bundled hosting services (more here)

### Geo Location
* Save/Query location of pubs/breweries and food trucks
* Save/Query location of beers on tap

## BigQuery and StackDriver
Beer-Fly uses BigQuery and StackDriver to create reports from user data and server-side logs.

## GitHub and Travis CI
Beer-Fly uses git for version control and Github as its online repository. BeerFly uses Travis for continuous integration in it's build and testing

## Google Place API
The idea of Beer-Fly is to give a "Craft-Beer-Centric" experience on top of Google's Place API.

Beer-Fly uses Google Places to:

* Find new craft breweries and pubs specializing in craft beer
* Display opening hours and contact information
* Track permanent closures.
* Uses business domain information and verified user emails to allow organization editing.

## Material Design
Beer-Fly uses Google's Material Design  

## Lessons Learned

### Polymer

Polymer has two goals:

1. Create reusable and shareable web components. 
2. Code close to the platform to create performant applications.

In some ways these goals are at cross-purposes.  As browsers update Polymer responds with breaking changes.  This makes  applications using many shared components difficult to update.

### Real-time NoSQL database

Data structure is key to managing an app that uses a NoSQL database.  The challenge is pulling more data than you need and managing all the listeners.  Beer-Fly currently pulls meta data and details for an organization when it first loads.  This is nice because the information is available locally when the internet connection is spotty.  However, it is currently impossible to only pull an organizations meta information. 

### Debugging 
Debugging two-way bindings, slow internet connections, and race conditions can eat a lot of time and energy.  Might make sense to refactor to Redux or Flux. 

### ES6 Modules and Web Components
But with the wide adoption of ES6 modules, it probably makes sense to refactor away from web components.
  

### CSS
After years of debugging overly complicated stylesheets I wanted simplify.  Currently a component's CSS is located within the HTML template and using variables for colors.  It is easy to debug, but hard to globally manage aspects such as overall spacing, font-sizes, etc. 

### Testing
Polymer is easier to test for components built completely separately.  

### Error Handling
Refactor to use Error Boundaries and add ways to report the error to a central logger. 

## What's Next

### Polymer or Framework?

Beer-Fly runs just fine on Polymer, but there are significant changes in Polymer 3.0.  This is probably a good opportunity to refactor to React or Preact. 

### NoSql Database or Datastore?

Beer-Fly runs on a NoSQl database, it probably makes sense to refactor to a document store model, which would be less expensive and cheaper and more flexible (send less data)
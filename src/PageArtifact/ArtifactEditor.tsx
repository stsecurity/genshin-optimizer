import { faQuestionCircle } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Add, PhotoCamera, Replay, Shuffle, Update } from '@mui/icons-material';
import { Alert, Box, Button, ButtonGroup, CardContent, CardHeader, CircularProgress, Grid, ListItemIcon, ListItemText, MenuItem, Skeleton, styled, Typography } from '@mui/material';
import React, { Suspense, useCallback, useContext, useEffect, useMemo, useReducer, useState } from 'react';
import ReactGA from 'react-ga';
import { Trans, useTranslation } from 'react-i18next';
import ArtifactRarityDropdown from '../Components/Artifact/ArtifactRarityDropdown';
import ArtifactSetDropdown from '../Components/Artifact/ArtifactSetDropdown';
import ArtifactSlotDropdown from '../Components/Artifact/ArtifactSlotDropdown';
import CardDark from '../Components/Card/CardDark';
import CardLight from '../Components/Card/CardLight';
import CloseButton from '../Components/CloseButton';
import CustomNumberTextField from '../Components/CustomNumberTextField';
import DropdownButton from '../Components/DropdownMenu/DropdownButton';
import ImgIcon from '../Components/Image/ImgIcon';
import ModalWrapper from '../Components/ModalWrapper';
import StatIcon from '../Components/StatIcon';
import Artifact from '../Data/Artifacts/Artifact';
import { ArtifactSheet } from '../Data/Artifacts/ArtifactSheet';
import { DatabaseContext } from '../Database/Database';
import { parseArtifact, validateArtifact } from '../Database/validation';
import KeyMap, { cacheValueString } from '../KeyMap';
import useForceUpdate from '../ReactHooks/useForceUpdate';
import usePromise from '../ReactHooks/usePromise';
import { allSubstats, IArtifact, ICachedArtifact, ISubstat, MainStatKey } from '../Types/artifact';
import { ArtifactRarity, ArtifactSetKey, SlotKey } from '../Types/consts';
import { randomizeArtifact } from '../Util/ArtifactUtil';
import { clamp, deepClone } from '../Util/Util';
import ArtifactCard from './ArtifactCard';
import SubstatEfficiencyDisplayCard from './ArtifactEditor/Components/SubstatEfficiencyDisplayCard';
import SubstatInput from './ArtifactEditor/Components/SubstatInput';
import UploadExplainationModal from './ArtifactEditor/Components/UploadExplainationModal';
import { OutstandingEntry, ProcessedEntry, processEntry, queueReducer } from './ScanningUtil';

const maxProcessingCount = 3, maxProcessedCount = 16
const allSubstatFilter = new Set(allSubstats)
type ResetMessage = { type: "reset" }
type SubstatMessage = { type: "substat", index: number, substat: ISubstat }
type OverwriteMessage = { type: "overwrite", artifact: IArtifact }
type UpdateMessage = { type: "update", artifact: Partial<IArtifact> }
type Message = ResetMessage | SubstatMessage | OverwriteMessage | UpdateMessage
interface IEditorArtifact {
  setKey: ArtifactSetKey,
  slotKey: SlotKey,
  level: number,
  rarity: ArtifactRarity,
  mainStatKey: MainStatKey,
  substats: ISubstat[],
}
function artifactReducer(state: IEditorArtifact | undefined, action: Message): IEditorArtifact | undefined {
  switch (action.type) {
    case "reset": return
    case "substat": {
      const { index, substat } = action
      const oldIndex = substat.key ? state!.substats.findIndex(current => current.key === substat.key) : -1
      if (oldIndex === -1 || oldIndex === index)
        state!.substats[index] = substat
      else  // Already in used, swap the items instead
        [state!.substats[index], state!.substats[oldIndex]] =
          [state!.substats[oldIndex], state!.substats[index]]
      return { ...state! }
    }
    case "overwrite": return action.artifact
    case "update": return { ...state!, ...action.artifact }
  }
}

const InputInvis = styled('input')({
  display: 'none',
});

export default function ArtifactEditor({ artifactIdToEdit = "", cancelEdit }: { artifactIdToEdit?: string, cancelEdit: () => void }) {
  const { t } = useTranslation("artifact")

  const artifactSheets = usePromise(ArtifactSheet.getAll, [])

  const { database } = useContext(DatabaseContext)

  const [show, setShow] = useState(false)

  const [dirtyDatabase, setDirtyDatabase] = useForceUpdate()
  useEffect(() => database.followAnyArt(setDirtyDatabase), [database, setDirtyDatabase])

  const [editorArtifact, artifactDispatch] = useReducer(artifactReducer, undefined)
  const artifact = useMemo(() => editorArtifact && parseArtifact(editorArtifact), [editorArtifact])

  const [modalShow, setModalShow] = useState(false)

  const [{ processed, outstanding }, dispatchQueue] = useReducer(queueReducer, { processed: [], outstanding: [] })
  const firstProcessed = processed[0] as ProcessedEntry | undefined
  const firstOutstanding = outstanding[0] as OutstandingEntry | undefined

  const processingImageURL = usePromise(firstOutstanding?.imageURL, [firstOutstanding?.imageURL])
  const processingResult = usePromise(firstOutstanding?.result, [firstOutstanding?.result])

  const remaining = processed.length + outstanding.length

  const image = firstProcessed?.imageURL ?? processingImageURL
  const { artifact: artifactProcessed, texts } = firstProcessed ?? {}
  // const fileName = firstProcessed?.fileName ?? firstOutstanding?.fileName ?? "Click here to upload Artifact screenshot files"

  useEffect(() => {
    if (!artifact && artifactProcessed)
      artifactDispatch({ type: "overwrite", artifact: artifactProcessed })
  }, [artifact, artifactProcessed, artifactDispatch])

  useEffect(() => {
    const numProcessing = Math.min(maxProcessedCount - processed.length, maxProcessingCount, outstanding.length)
    const processingCurrent = numProcessing && !outstanding[0].result
    outstanding.slice(0, numProcessing).forEach(processEntry)
    if (processingCurrent)
      dispatchQueue({ type: "processing" })
  }, [processed.length, outstanding])

  useEffect(() => {
    if (processingResult)
      dispatchQueue({ type: "processed", ...processingResult })
  }, [processingResult, dispatchQueue])

  const uploadFiles = useCallback((files: FileList) => {
    setShow(true)
    dispatchQueue({ type: "upload", files: [...files].map(file => ({ file, fileName: file.name })) })
  }, [dispatchQueue, setShow])
  const clearQueue = useCallback(() => dispatchQueue({ type: "clear" }), [dispatchQueue])

  useEffect(() => {
    const pasteFunc = (e: any) => uploadFiles(e.clipboardData.files)
    window.addEventListener('paste', pasteFunc);
    return () =>
      window.removeEventListener('paste', pasteFunc)
  }, [uploadFiles])

  const onUpload = useCallback(
    e => {
      uploadFiles(e.target.files)
      e.target.value = null // reset the value so the same file can be uploaded again...
    },
    [uploadFiles],
  )

  const { old, oldType }: { old: ICachedArtifact | undefined, oldType: "edit" | "duplicate" | "upgrade" | "" } = useMemo(() => {
    const databaseArtifact = dirtyDatabase && artifactIdToEdit && database._getArt(artifactIdToEdit)
    if (databaseArtifact) return { old: databaseArtifact, oldType: "edit" }
    if (artifact === undefined) return { old: undefined, oldType: "" }
    const { duplicated, upgraded } = dirtyDatabase && database.findDuplicates(artifact)
    return { old: duplicated[0] ?? upgraded[0], oldType: duplicated.length !== 0 ? "duplicate" : "upgrade" }
  }, [artifact, artifactIdToEdit, database, dirtyDatabase])

  const { artifact: cachedArtifact, errors } = useMemo(() => {
    if (!artifact) return { artifact: undefined, errors: [] as Displayable[] }
    const validated = validateArtifact(artifact, artifactIdToEdit)
    if (old) {
      validated.artifact.location = old.location
      validated.artifact.exclude = old.exclude
    }
    return validated
  }, [artifact, artifactIdToEdit, old])

  // Overwriting using a different function from `databaseArtifact` because `useMemo` does not
  // guarantee to trigger *only when* dependencies change, which is necessary in this case.
  useEffect(() => {
    if (artifactIdToEdit === "new") {
      setShow(true)
      artifactDispatch({ type: "reset" })
    }
    const databaseArtifact = artifactIdToEdit && dirtyDatabase && database._getArt(artifactIdToEdit)
    if (databaseArtifact) {
      setShow(true)
      artifactDispatch({ type: "overwrite", artifact: deepClone(databaseArtifact) })
    }
  }, [artifactIdToEdit, database, dirtyDatabase])

  const sheet = artifact ? artifactSheets?.[artifact.setKey] : undefined
  const reset = useCallback(() => {
    cancelEdit?.();
    dispatchQueue({ type: "pop" })
    artifactDispatch({ type: "reset" })
  }, [cancelEdit, artifactDispatch])
  const update = useCallback((newValue: Partial<IArtifact>) => {
    const newSheet = newValue.setKey ? artifactSheets![newValue.setKey] : sheet!

    function pick<T>(value: T | undefined, available: readonly T[], prefer?: T): T {
      return (value && available.includes(value)) ? value : (prefer ?? available[0])
    }

    if (newValue.setKey) {
      newValue.rarity = pick(artifact?.rarity, newSheet.rarity, Math.max(...newSheet.rarity) as ArtifactRarity)
      newValue.slotKey = pick(artifact?.slotKey, newSheet.slots)
    }
    if (newValue.rarity)
      newValue.level = artifact?.level ?? 0
    if (newValue.level)
      newValue.level = clamp(newValue.level, 0, 4 * (newValue.rarity ?? artifact!.rarity))
    if (newValue.slotKey)
      newValue.mainStatKey = pick(artifact?.mainStatKey, Artifact.slotMainStats(newValue.slotKey))

    if (newValue.mainStatKey) {
      newValue.substats = [0, 1, 2, 3].map(i =>
        (artifact && artifact.substats[i].key !== newValue.mainStatKey) ? artifact!.substats[i] : { key: "", value: 0 })
    }
    artifactDispatch({ type: "update", artifact: newValue })
  }, [artifact, artifactSheets, sheet, artifactDispatch])
  const setSubstat = useCallback((index: number, substat: ISubstat) => {
    artifactDispatch({ type: "substat", index, substat })
  }, [artifactDispatch])
  const isValid = !errors.length
  const canClearArtifact = (): boolean => window.confirm(t`editor.clearPrompt` as string)
  const { rarity = 5, level = 0, slotKey = "flower" } = artifact ?? {}
  const { currentEfficiency = 0, maxEfficiency = 0 } = cachedArtifact ? Artifact.getArtifactEfficiency(cachedArtifact, allSubstatFilter) : {}
  const preventClosing = processed.length || outstanding.length
  const onClose = useCallback(
    (e) => {
      if (preventClosing) e.preventDefault()
      setShow(false)
      cancelEdit()
    }, [preventClosing, setShow, cancelEdit])
  return <ModalWrapper open={show} onClose={onClose} >
    <Suspense fallback={<Skeleton variant="rectangular" sx={{ width: "100%", height: show ? "100%" : 64 }} />}><CardDark >
      <UploadExplainationModal modalShow={modalShow} hide={() => setModalShow(false)} />
      <CardHeader
        title={<Trans t={t} i18nKey="editor.title" >Artifact Editor</Trans>}
        action={<CloseButton disabled={!!preventClosing} onClick={onClose} />}
      />
      <CardContent sx={{ pt: 0 }}>
        <Grid container spacing={1} sx={{ mb: 1 }}>
          {/* Left column */}
          <Grid item xs={12} md={6} lg={6} sx={{
            // select all excluding last
            "> div:nth-last-of-type(n+2)": { mb: 1 }
          }}>
            {/* set & rarity */}
            <ButtonGroup sx={{ display: "flex", mb: 1 }}>
              {/* Artifact Set */}
              <ArtifactSetDropdown selectedSetKey={artifact?.setKey} onChange={setKey => update({ setKey: setKey as ArtifactSetKey })} sx={{ flexGrow: 1 }} />
              {/* rarity dropdown */}
              <ArtifactRarityDropdown rarity={artifact ? rarity : undefined} onChange={r => update({ rarity: r })} filter={r => !!sheet?.rarity?.includes?.(r)} disabled={!sheet} />
            </ButtonGroup>

            {/* level */}
            <Box component="div" display="flex">
              <CustomNumberTextField id="filled-basic" label="Level" variant="filled" sx={{ flexShrink: 1, flexGrow: 1, mr: 1, my: 0 }} margin="dense" size="small"
                value={level} disabled={!sheet} placeholder={`0~${rarity * 4}`} onChange={l => update({ level: l })}
              />
              <ButtonGroup >
                <Button onClick={() => update({ level: level - 1 })} disabled={!sheet || level === 0}>-</Button>
                {rarity ? [...Array(rarity + 1).keys()].map(i => 4 * i).map(i => <Button key={i} onClick={() => update({ level: i })} disabled={!sheet || level === i}>{i}</Button>) : null}
                <Button onClick={() => update({ level: level + 1 })} disabled={!sheet || level === (rarity * 4)}>+</Button>
              </ButtonGroup>
            </Box>

            {/* slot */}
            <Box component="div" display="flex">
              <ArtifactSlotDropdown disabled={!sheet} slotKey={slotKey} onChange={slotKey => update({ slotKey })} />
              <CardLight sx={{ p: 1, ml: 1, flexGrow: 1 }}>
                <Suspense fallback={<Skeleton width="60%" />}>
                  <Typography color="text.secondary">
                    {sheet?.getSlotName(artifact!.slotKey) ? <span><ImgIcon src={sheet.slotIcons[artifact!.slotKey]} /> {sheet?.getSlotName(artifact!.slotKey)}</span> : t`editor.unknownPieceName`}
                  </Typography>
                </Suspense>
              </CardLight>
            </Box>

            {/* main stat */}
            <Box component="div" display="flex">
              <DropdownButton startIcon={artifact?.mainStatKey ? StatIcon[artifact.mainStatKey] : undefined} title={<b>{artifact ? KeyMap.get(artifact.mainStatKey) : t`mainStat`}</b>} disabled={!sheet} color={artifact ? "success" : "primary"} >
                {Artifact.slotMainStats(slotKey).map(mainStatK =>
                  <MenuItem key={mainStatK} selected={artifact?.mainStatKey === mainStatK} disabled={artifact?.mainStatKey === mainStatK} onClick={() => update({ mainStatKey: mainStatK })} >
                    <ListItemIcon>{StatIcon[mainStatK]}</ListItemIcon>
                    <ListItemText>{KeyMap.get(mainStatK)}</ListItemText>
                  </MenuItem>)}
              </DropdownButton>
              <CardLight sx={{ p: 1, ml: 1, flexGrow: 1 }}>
                <Typography color="text.secondary">
                  {artifact ? `${cacheValueString(Artifact.mainStatValue(artifact.mainStatKey, rarity, level), KeyMap.unit(artifact.mainStatKey))}${KeyMap.unitStr(artifact.mainStatKey)}` : t`mainStat`}
                </Typography>
              </CardLight>
            </Box>

            {/* Current/Max Substats Efficiency */}
            <SubstatEfficiencyDisplayCard valid={isValid} efficiency={currentEfficiency} t={t} />
            {currentEfficiency !== maxEfficiency && <SubstatEfficiencyDisplayCard max valid={isValid} efficiency={maxEfficiency} t={t} />}

            {/* Image OCR */}
            <CardLight>
              <CardContent sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
                {/* TODO: artifactDispatch not overwrite */}
                <Suspense fallback={<Skeleton width="100%" height="100" />}>
                  <Grid container spacing={1} alignItems="center">
                    <Grid item flexGrow={1}>
                      <label htmlFor="contained-button-file">
                        <InputInvis accept="image/*" id="contained-button-file" multiple type="file" onChange={onUpload} />
                        <Button component="span" startIcon={<PhotoCamera />}>
                          Upload Screenshot (or Ctrl-V)
                        </Button>
                      </label>
                    </Grid>
                    <Grid item>
                      <Button color="info" sx={{ px: 2, minWidth: 0 }} onClick={() => {
                        setModalShow(true)
                        ReactGA.modalview('/artifact/how-to-upload')
                      }}><Typography><FontAwesomeIcon icon={faQuestionCircle} /></Typography></Button>
                    </Grid>
                  </Grid>
                  {image && <Box display="flex" justifyContent="center">
                    <Box component="img" src={image} width="100%" maxWidth={350} height="auto" alt="Screenshot to parse for artifact values" />
                  </Box>}
                  {remaining > 0 && <CardDark sx={{ pl: 2 }} ><Grid container spacing={1} alignItems="center" >
                    {!firstProcessed && firstOutstanding && <Grid item>
                      <CircularProgress size="1em" />
                    </Grid>}
                    <Grid item flexGrow={1}>
                      <Typography>
                        <span>
                          Screenshots in file-queue: <b>{remaining}</b>
                          {/* {process.env.NODE_ENV === "development" && ` (Debug: Processed ${processed.length}/${maxProcessedCount}, Processing: ${outstanding.filter(entry => entry.result).length}/${maxProcessingCount}, Outstanding: ${outstanding.length})`} */}
                        </span>
                      </Typography>
                    </Grid>
                    <Grid item>
                      <Button size="small" color="error" onClick={clearQueue}>Clear file-queue</Button>
                    </Grid>
                  </Grid></CardDark>}
                </Suspense>
              </CardContent>
            </CardLight>
          </Grid>

          {/* Right column */}
          <Grid item xs={12} md={6} lg={6} display="flex" flexDirection="column" gap={1}>
            {/* substat selections */}
            {[0, 1, 2, 3].map((index) => <SubstatInput key={index} index={index} artifact={cachedArtifact} setSubstat={setSubstat} />)}
            {texts && <CardLight><CardContent>
              <div>{texts.slotKey}</div>
              <div>{texts.mainStatKey}</div>
              <div>{texts.mainStatVal}</div>
              <div>{texts.rarity}</div>
              <div>{texts.level}</div>
              <div>{texts.substats}</div>
              <div>{texts.setKey}</div>
            </CardContent></CardLight>}
          </Grid>
        </Grid>

        {/* Duplicate/Updated/Edit UI */}
        {old && <Grid container sx={{ justifyContent: "space-around", mb: 1 }} spacing={1} >
          <Grid item lg={4} md={6} ><CardLight>
            <Typography sx={{ textAlign: "center" }} py={1} variant="h6" color="text.secondary" >{t`editor.preview`}</Typography>
            <ArtifactCard artifactObj={cachedArtifact} />
          </CardLight></Grid>
          <Grid item lg={4} md={6} ><CardLight>
            <Typography sx={{ textAlign: "center" }} py={1} variant="h6" color="text.secondary" >{oldType !== "edit" ? (oldType === "duplicate" ? t`editor.dupArt` : t`editor.upArt`) : t`editor.beforeEdit`}</Typography>
            <ArtifactCard artifactObj={old} />
          </CardLight></Grid>
        </Grid>}

        {/* Error alert */}
        {!isValid && <Alert variant="filled" severity="error" sx={{ mb: 1 }}>{errors.map((e, i) => <div key={i}>{e}</div>)}</Alert>}

        {/* Buttons */}
        <Grid container spacing={2}>
          <Grid item>
            {oldType === "edit" ?
              <Button startIcon={<Add />} onClick={() => { database.updateArt(editorArtifact!, old!.id); reset() }} disabled={!editorArtifact || !isValid} color="primary">
                {t`editor.btnSave`}
              </Button> :
              <Button startIcon={<Add />} onClick={() => { database.createArt(artifact!); reset() }} disabled={!artifact || !isValid} color={oldType === "duplicate" ? "warning" : "primary"}>
                {t`editor.btnAdd`}
              </Button>}
          </Grid>
          <Grid item flexGrow={1}>
            <Button startIcon={<Replay />} disabled={!artifact} onClick={() => { canClearArtifact() && reset() }} color="error">{t`editor.btnClear`}</Button>
          </Grid>
          <Grid item>
            {process.env.NODE_ENV === "development" && <Button color="info" startIcon={<Shuffle />} onClick={async () => artifactDispatch({ type: "overwrite", artifact: await randomizeArtifact() })}>{t`editor.btnRandom`}</Button>}
          </Grid>
          {old && oldType !== "edit" && <Grid item>
            <Button startIcon={<Update />} onClick={() => { database.updateArt(editorArtifact!, old.id); reset() }} disabled={!editorArtifact || !isValid} color="success">{t`editor.btnUpdate`}</Button>
          </Grid>}
        </Grid>
      </CardContent>
    </CardDark ></Suspense>
  </ModalWrapper>
}
